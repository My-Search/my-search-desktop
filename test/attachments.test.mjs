/**
 * 搜索框附件（粘贴/拖入文件·文件夹 → 过滤可处理插件）纯逻辑测试。
 *
 * 覆盖契约：
 *   1. 清单 contributes.handlers 的解析校验（manifest.ts）
 *   2. 附件合并去重 / 类型集合（attachments.ts）
 *   3. 过滤谓词 buildAttachmentFilter（能力匹配、非插件项/禁用插件剔除、惰性记录）
 *   4. 引擎附件模式：resultFilter 生效、PRO 分支按父关键词过滤候选、
 *      空父词不触发「问AI」重定向；未挂过滤时旧重定向行为不变（回归）
 *
 * 用法: node test/attachments.test.mjs
 */
import { parsePluginManifest, describeManifestError, inputHandlersOf } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";
import {
  attachmentKinds,
  hasFolder,
  mergeAttachments,
  buildAttachmentFilter,
  attachmentPlaceholder,
  isPreviewImage,
  extOf,
  PREVIEW_IMAGE_EXTS,
} from "../src/lib/plugins/attachments.ts";
import { SearchEngine, SEARCH_BOUNDARY, SEARCH_PRO_TAG } from "../src/lib/search-engine.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, extra);
  }
};

/* ---------- 1. 清单 handlers 校验 ---------- */
{
  const base = {
    id: "com.example.attach-test",
    name: "附件测试",
    version: "1.0.0",
    apiVersion: 1,
  };

  const r1 = parsePluginManifest({ ...base, contributes: { handlers: { files: true } } });
  ok(r1.ok && r1.manifest.contributes?.handlers?.files === true, "handlers.files=true 解析通过");

  const r2 = parsePluginManifest({ ...base, contributes: { handlers: { folders: true, files: false } } });
  ok(
    r2.ok && r2.manifest.contributes?.handlers?.folders === true && r2.manifest.contributes?.handlers?.files === false,
    "handlers.folders=true / files=false 解析通过"
  );

  const r3 = parsePluginManifest({ ...base, contributes: { handlers: { files: "yes" } } });
  ok(!r3.ok && r3.errors.includes("contributes.handlers.files.invalid"), "handlers.files 非布尔 → 报错", JSON.stringify(r3.errors));
  ok(
    describeManifestError("contributes.handlers.files.invalid").includes("布尔"),
    "handlers.files 错误码可翻译"
  );

  const r4 = parsePluginManifest({ ...base, contributes: { handlers: [] } });
  ok(!r4.ok && r4.errors.includes("contributes.handlers.invalid"), "handlers 数组 → 报错", JSON.stringify(r4.errors));

  const r5 = parsePluginManifest({ ...base, contributes: { handlers: { files: false, folders: false } } });
  ok(r5.ok && r5.manifest.contributes?.handlers == null, "两个能力都 false → 视同未声明");

  const r6 = parsePluginManifest({ ...base });
  const h = inputHandlersOf(r6.ok ? r6.manifest : null);
  ok(!h.files && !h.folders, "未声明 handlers → 两类能力均为 false");

  ok(isKnownPermission("file.read"), "权限目录认识 file.read");
}

/* ---------- 2. 附件合并 / 类型集合 ---------- */
{
  const f = (path, name = "f.txt") => ({ kind: "file", name, path });
  const d = (path, name = "dir") => ({ kind: "folder", name, path });

  const merged = mergeAttachments([f("C:/a/one.txt")], [f("C:/a/one.txt"), f("C:/a/ONE.TXT"), f("C:/a/two.txt")]);
  ok(merged.length === 2, "按路径去重（大小写不敏感）", JSON.stringify(merged));

  const merged2 = mergeAttachments([f("")], [{ kind: "file", name: "x.png", path: "" }, { kind: "bad", name: "y", path: "" }]);
  ok(merged2.length === 2, "空路径按 名称+类型 去重、非法 kind 丢弃", JSON.stringify(merged2));

  const kinds = attachmentKinds([f("C:/a/1.txt"), d("C:/b")]);
  ok(kinds.has("file") && kinds.has("folder"), "attachmentKinds 收集两类");
  ok(hasFolder([d("C:/b")]) && !hasFolder([f("C:/a")]), "hasFolder 判定");

  const nullFilterEntries = [];
  ok(attachmentKinds(nullFilterEntries).size === 0, "空附件 → 类型集合为空");
  ok(attachmentPlaceholder(3) === "插件关键词[tab]传入文本", "占位提示为简短范式文案");
}

/* ---------- 2.5 图片识别（决定 chip 显示缩略图还是图标+名称） ---------- */
{
  ok(extOf("a.PNG") === "png", "扩展名大小写归一");
  ok(extOf("无扩展名") === "" && extOf(".hidden") === "" && extOf("a.") === "", "无扩展名 → 空串");

  const f = (name) => ({ kind: "file", name, path: "C:/x/" + name });
  const d = (name) => ({ kind: "folder", name, path: "C:/x/" + name });

  ok(isPreviewImage(f("a.png")), "png → 图片");
  ok(isPreviewImage(f("照片.JPEG")), "jpeg（大写）→ 图片");
  ok(isPreviewImage(f("icon.svg")), "svg → 图片");
  ok(isPreviewImage(f("anim.webp")) && isPreviewImage(f("b.ico")) && isPreviewImage(f("c.avif")), "webp/ico/avif → 图片");
  ok(!isPreviewImage(f("doc.pdf")) && !isPreviewImage(f("readme.md")) && !isPreviewImage(f("noext")), "非图片 → 不预览");
  ok(!isPreviewImage(d("图片文件夹.png")), "文件夹即使名字像图片也不预览");
  ok(PREVIEW_IMAGE_EXTS.length === 9, "图片扩展名白名单为 9 项（与 Rust 侧一致）");
}

/* ---------- 3. 过滤谓词 ---------- */
{
  const mkRecord = (id, handlers, enabled = true) => ({
    id,
    enabled,
    manifest: { contributes: handlers ? { handlers } : undefined },
  });
  const fileRec = mkRecord("com.example.uploader", { files: true });
  const folderRec = mkRecord("com.example.finder", { folders: true });
  const noneRec = mkRecord("com.example.plain", undefined);
  const offRec = mkRecord("com.example.off", { files: true }, false);

  let records = [fileRec, folderRec, noneRec, offRec];
  const getRecords = () => records;

  const itemOf = (pid) => ({ title: "T", type: "script", _pluginId: pid });
  const plainItem = { title: "普通订阅项", type: "script" };

  ok(buildAttachmentFilter([], getRecords) === null, "无附件 → 谓词为 null（不过滤）");

  const fileFilter = buildAttachmentFilter([{ kind: "file", name: "a.png", path: "C:/a.png" }], getRecords);
  ok(fileFilter != null, "有文件附件 → 产生谓词");
  ok(fileFilter(itemOf("com.example.uploader")), "文件附件：文件类插件入围");
  ok(!fileFilter(itemOf("com.example.finder")), "文件附件：仅文件夹能力的插件不入围");
  ok(!fileFilter(itemOf("com.example.plain")), "文件附件：未声明能力的插件不入围");
  ok(!fileFilter(itemOf("com.example.off")), "文件附件：禁用插件不入围");
  ok(!fileFilter(plainItem), "文件附件：非插件项一律过滤");

  const folderFilter = buildAttachmentFilter([{ kind: "folder", name: "docs", path: "C:/docs" }], getRecords);
  ok(folderFilter(itemOf("com.example.finder")), "文件夹附件：文件夹类插件入围");
  ok(!folderFilter(itemOf("com.example.uploader")), "文件夹附件：仅文件能力的插件不入围");

  const mixedFilter = buildAttachmentFilter(
    [{ kind: "folder", name: "docs", path: "C:/docs" }, { kind: "file", name: "a.png", path: "C:/a.png" }],
    getRecords
  );
  ok(
    mixedFilter(itemOf("com.example.finder")) && mixedFilter(itemOf("com.example.uploader")),
    "混合附件：能处理任一类型的插件都入围"
  );

  // 惰性读取器：记录变化后同一谓词拿到最新注册表
  records = [folderRec];
  ok(
    !folderFilter(itemOf("com.example.uploader")) && folderFilter(itemOf("com.example.finder")),
    "谓词惰性读取记录（禁用/卸载即时生效）"
  );
}

/* ---------- 4. 引擎附件模式 ---------- */
{
  const mkEngine = () => new SearchEngine();

  const fileSearchItem = {
    title: "文件搜索",
    desc: "在文件夹里搜文件",
    resource: "",
    type: "script",
    _pluginId: "com.mysearch.file-search",
    _pluginKeyword: "文件搜索",
  };
  const uploaderItem = {
    title: "GitHub 文件上传",
    desc: "上传文件",
    resource: "",
    type: "script",
    _pluginId: "com.zhuangjie.github-upload",
    _pluginKeyword: "上传",
  };
  const plainItem = { title: "文件搜索神器订阅项", desc: "", resource: "https://example.com", type: "url" };

  const records = [
    { id: "com.mysearch.file-search", enabled: true, manifest: { contributes: { handlers: { folders: true } } } },
    { id: "com.zhuangjie.github-upload", enabled: true, manifest: { contributes: { handlers: { files: true } } } },
  ];

  // 4.1 普通搜索：过滤生效，只剩能力匹配的插件项
  {
    const engine = mkEngine();
    engine.searchData = [fileSearchItem, uploaderItem, plainItem];
    engine.resultFilter = buildAttachmentFilter([{ kind: "folder", name: "docs", path: "C:/docs" }], () => records);
    const res = await engine.search("文件搜索");
    ok(res.length >= 1 && res.every((r) => r.item._pluginId === "com.mysearch.file-search"), "普通搜索：文件夹附件只留文件搜索插件", JSON.stringify(res.map((r) => r.item.title)));
    ok(!res.some((r) => r.item.title.includes("订阅")), "普通搜索：非插件项被过滤");
  }

  // 4.2 PRO 分支：父关键词过滤候选；子关键词（boundary 之后）不参与检索
  {
    const engine = mkEngine();
    engine.searchData = [fileSearchItem, uploaderItem, plainItem];
    engine.resultFilter = buildAttachmentFilter([{ kind: "folder", name: "docs", path: "C:/docs" }], () => records);
    const res = await engine.search(`上传${SEARCH_BOUNDARY}hello world`);
    // 文件夹附件下「上传」只可能命中…… 文件搜索插件不含「上传」，父词无命中 → 模糊兜底仍限制在候选内
    ok(res.every((r) => r.item._pluginId === "com.mysearch.file-search"), "PRO 父词过滤限制在候选内", JSON.stringify(res.map((r) => r.item.title)));

    const res2 = await engine.search(`文件搜索${SEARCH_BOUNDARY}报告`);
    ok(res2.length > 0 && res2[0].item._pluginId === "com.mysearch.file-search", "PRO 父词命中候选插件");

    const res3 = await engine.search(`xyz不存在${SEARCH_BOUNDARY}q`);
    ok(res3.every((r) => r.item._pluginId === "com.mysearch.file-search"), "PRO 父词无命中时模糊兜底也不出候选");
  }

  // 4.3 附件模式空父词：列出全部候选，且不触发「问AI」重定向
  {
    const engine = mkEngine();
    engine.searchData = [fileSearchItem, uploaderItem, plainItem];
    engine.resultFilter = buildAttachmentFilter([{ kind: "folder", name: "docs", path: "C:/docs" }], () => records);
    let redirected = null;
    engine.onRedirect = (kw) => { redirected = kw; };
    const res = await engine.search(`${SEARCH_BOUNDARY}`); // " : "（只有分隔符）
    ok(res.length === 1 && res[0].item._pluginId === "com.mysearch.file-search", "附件模式空父词 → 列出候选插件", JSON.stringify(res.map((r) => r.item.title)));
    ok(redirected === null, "附件模式空父词不触发「问AI」重定向");
  }

  // 4.4 回归：未挂过滤时，空父词不再跳转「问AI」，而是「不进行过滤」列出全部可搜索项
  {
    const engine = mkEngine();
    const searchable = {
      title: `${SEARCH_PRO_TAG}问AI`,
      desc: "",
      resource: "https://a.com/?q={keyword}",
      type: "script",
    };
    engine.searchData = [searchable, plainItem];
    const res = await engine.search(`${SEARCH_BOUNDARY}`);
    ok(
      res.length === 1 && res[0].item === searchable,
      "无附件空父词 → 不过滤，列出全部 [可搜索] 项（不跳转问AI）",
      JSON.stringify(res.map((r) => r.item.title))
    );
    ok(!res.some((r) => r.item === plainItem), "非可搜索项不进 PRO 域");
    ok(!("_pendingRedirectKeyword" in engine), "引擎已无「问AI」待转发字段");
  }

  // 4.5 通用分支：resultFilter 也作用于 special / fuzzy 路径（用文件附件验证 fuzzy 前的精确分支即可）
  {
    const engine = mkEngine();
    engine.searchData = [fileSearchItem, plainItem];
    engine.resultFilter = buildAttachmentFilter([{ kind: "file", name: "a.png", path: "C:/a.png" }], () => records);
    const res = await engine.search("文件搜索神器订阅项"); // 只有非插件项标题全中
    ok(res.every((r) => pluginHas(r)), "精确命中非插件项时被过滤（文件附件下无入围插件）", JSON.stringify(res));
    function pluginHas(r) {
      return r.item._pluginId != null;
    }
    ok(res.length === 0, "文件附件下文件搜索插件不入围 → 结果为空");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
