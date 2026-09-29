/**
 * 「二次搜索（`父 : 子`）候选由谁决定」契约测试。
 *
 * 背景：PRO 模式只检索带 `[可搜索]` 标记的项，而插件项的 resource 是空的，
 * 因此历史上只要插件声明了 keyword，宿主就无条件补 `[可搜索]` —— 等于
 * 「声明 keyword」被当成了「支持二次搜索」。但对不消费子关键词的插件
 * （如 GitHub 文件上传：子词只是 commit message），列在二次搜索候选里只会误导
 * 用户：回车后看不到任何二次搜索效果。
 *
 * 修正：`contributes.searchItem.subSearch`（默认 **false**）显式声明是否参与
 * 二次搜索候选，宿主据它决定是否补 `[可搜索]`。判定必须声明式——插件脚本要等
 * 视图打开才执行，晚于结果列表渲染，无法运行时探测。
 *
 * 覆盖契约：
 *   1. 清单解析：subSearch 默认 false、显式 true/false、非布尔值报错
 *   2. buildPluginItems：把清单值投影到 `_pluginSubSearch`
 *   3. 引擎 _indexItem：只有声明 true 才补 `[可搜索]`，普通搜索不受影响
 *   4. PRO 模式：未声明的插件项不在二次搜索候选里（父词命中或空父词都不出现）
 *   5. 附件模式：不查 `[可搜索]`，故「粘贴文件 → 上传 : commit」主路径完好
 *
 * 用法: node test/plugin-subsearch.test.mjs
 */
import { parsePluginManifest } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";
import { buildPluginItems, pluginSubSearchOf } from "../src/lib/plugins/plugin-items.ts";
import { SearchEngine, SEARCH_BOUNDARY, SEARCH_PRO_TAG } from "../src/lib/search-engine.ts";
import { buildAttachmentFilter } from "../src/lib/plugins/attachments.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const manifestOf = (searchItem) =>
  parsePluginManifest(
    JSON.stringify({
      id: "com.example.sub-search",
      name: "二次搜索测试",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["ui.inlay"],
      contributes: { searchItem, detailView: { entry: "ui/index.html" } },
    }),
    isKnownPermission
  );

/* ============ 1. 清单解析 ============ */
{
  const r = manifestOf({ title: "默认插件", keyword: "默认" });
  ok(r.ok, "未声明 subSearch 的清单合法", (r.errors ?? []).join(","));
  ok(r.manifest.contributes?.searchItem?.subSearch === false, "未声明 → 默认 false（不进二次搜索候选）");

  const rTrue = manifestOf({ title: "开启", keyword: "开", subSearch: true });
  ok(rTrue.ok && rTrue.manifest.contributes?.searchItem?.subSearch === true, "显式 true 被保留");

  const rFalse = manifestOf({ title: "关闭", keyword: "关", subSearch: false });
  ok(rFalse.ok && rFalse.manifest.contributes?.searchItem?.subSearch === false, "显式 false 被保留");

  const rBad = manifestOf({ title: "坏值", keyword: "坏", subSearch: "yes" });
  ok(!rBad.ok, "subSearch 非布尔值 → 清单不合法");
  ok(
    (rBad.errors ?? []).includes("contributes.searchItem.subSearch.invalid:0"),
    "错误码为 contributes.searchItem.subSearch.invalid（单对象形态带下标 0）",
    (rBad.errors ?? []).join(",")
  );

  // 数组形态同样校验（多搜索项插件可逐条决定）
  const rArr = manifestOf([
    { title: "A", keyword: "a", subSearch: true },
    { title: "B", keyword: "b" },
  ]);
  ok(
    rArr.ok &&
      rArr.manifest.contributes?.searchItem?.[0]?.subSearch === true &&
      rArr.manifest.contributes?.searchItem?.[1]?.subSearch === false,
    "数组：逐条取值，未声明的仍默认 false"
  );
  const rArrBad = manifestOf([{ title: "A", keyword: "a" }, { title: "B", keyword: "b", subSearch: 1 }]);
  ok(
    !rArrBad.ok && (rArrBad.errors ?? []).includes("contributes.searchItem.subSearch.invalid:1"),
    "数组：坏值错误码带下标",
    (rArrBad.errors ?? []).join(",")
  );
}

/* ============ 2. 合成条目上的标记 ============ */
{
  const record = (subSearch) => ({
    id: "com.example.sub-search",
    name: "二次搜索测试",
    version: "1.0.0",
    enabled: true,
    manifest: manifestOf({ title: "条目", keyword: "kw", subSearch }).manifest,
  });

  ok(pluginSubSearchOf(buildPluginItems(record(true))[0]) === true, "声明 true → _pluginSubSearch 为 true");
  ok(pluginSubSearchOf(buildPluginItems(record(false))[0]) === false, "声明 false → _pluginSubSearch 为 false");
  // 缺省字段（老清单没这个键）同样按 false 处理
  const legacy = record(undefined);
  legacy.manifest.contributes.searchItem = { title: "条目", keyword: "kw" };
  ok(pluginSubSearchOf(buildPluginItems(legacy)[0]) === false, "老清单（无 subSearch 键）→ false");
}

/* ============ 3. _indexItem：只有声明 true 才补 [可搜索] ============ */
{
  const mkEngine = () => new SearchEngine();

  const tagged = {
    title: "参与二次搜索",
    desc: "",
    type: "script",
    _pluginId: "com.example.sub-search",
    _pluginKeyword: "参与",
    _pluginSubSearch: true,
  };
  const untagged = {
    title: "不参与二次搜索",
    desc: "",
    type: "script",
    _pluginId: "com.example.sub-search",
    _pluginKeyword: "不参与",
    _pluginSubSearch: false,
  };

  const engine = mkEngine();
  engine.searchData = [tagged, untagged];
  engine._buildIndex();
  ok(tagged.title.startsWith(SEARCH_PRO_TAG), "声明 true → 补上 [可搜索]", tagged.title);
  ok(!untagged.title.includes(SEARCH_PRO_TAG), "声明 false → 不补 [可搜索]", untagged.title);
}

/* ============ 4. PRO 模式：未声明的不进二次搜索候选 ============ */
{
  const mkEngine = () => new SearchEngine();

  const subSearcher = {
    title: "参与搜索",
    desc: "",
    type: "script",
    _pluginId: "com.example.sub-search",
    _pluginKeyword: "参与",
    _pluginSubSearch: true,
  };
  const uploader = {
    title: "GitHub 文件上传",
    desc: "拖拽/粘贴/选择文件，上传到 GitHub 并获取直链",
    type: "script",
    _pluginId: "com.zhuangjie.github-upload",
    _pluginKeyword: "上传",
    _pluginSubSearch: false,
  };
  const searchableUrl = {
    title: `${SEARCH_PRO_TAG}可搜索订阅项`,
    desc: "",
    resource: "https://a.com/?q={keyword}",
    type: "url",
  };

  // 4.1 父词命中插件项标题：只有声明 true 的入围
  {
    const engine = mkEngine();
    engine.searchData = [subSearcher, uploader, searchableUrl];
    engine._buildIndex();
    const res = await engine.search(`参与${SEARCH_BOUNDARY}子词`);
    ok(res.every((r) => r.item === subSearcher), "父词命中：仅声明 true 的插件项入围", JSON.stringify(res.map((r) => r.item.title)));
  }

  // 4.2 空父词（Tab 后停在 " : "）：不过滤，但也不该把不参与的插件项列出来
  {
    const engine = mkEngine();
    engine.searchData = [subSearcher, uploader, searchableUrl];
    engine._buildIndex();
    const res = await engine.search(`${SEARCH_BOUNDARY}`);
    ok(
      res.some((r) => r.item === subSearcher) && res.some((r) => r.item === searchableUrl),
      "空父词：参与二次搜索的项照常列出",
      JSON.stringify(res.map((r) => r.item.title))
    );
    ok(!res.some((r) => r.item === uploader), "空父词：不参与的插件项不出现在候选里");
  }

  // 4.3 模糊兜底同样限制在 [可搜索] 域内
  {
    const engine = mkEngine();
    engine.searchData = [subSearcher, uploader, searchableUrl];
    engine._buildIndex();
    const res = await engine.search(` GitHub${SEARCH_BOUNDARY}xxx `);
    ok(
      res.every((r) => r.item !== uploader),
      "父词模糊命中上传插件：仍不进候选（未声明 subSearch）",
      JSON.stringify(res.map((r) => r.item.title))
    );
  }

  // 4.4 普通搜索（无边界符）：插件项照常可搜、可打开——只是不进二次搜索
  {
    const engine = mkEngine();
    engine.searchData = [subSearcher, uploader];
    engine._buildIndex();
    const res = await engine.search("上传");
    ok(res.some((r) => r.item === uploader), "普通搜索仍能命中并打开上传插件");
  }
}

/* ============ 5. 附件模式：主路径不受影响 ============ */
{
  const mkEngine = () => new SearchEngine();

  const records = [
    { id: "com.zhuangjie.github-upload", enabled: true, manifest: { contributes: { handlers: { files: true } } } },
    { id: "com.example.sub-search", enabled: true, manifest: { contributes: { handlers: {} } } },
  ];
  const uploader = {
    title: "GitHub 文件上传",
    desc: "上传文件",
    type: "script",
    _pluginId: "com.zhuangjie.github-upload",
    _pluginKeyword: "上传",
    _pluginSubSearch: false,
  };

  // 附件模式走 resultFilter，不查 [可搜索]；粘贴文件后仍能选到上传插件，
  // 再输入「上传 : commit」也能把 commit 交给它。
  {
    const engine = mkEngine();
    engine.searchData = [uploader];
    engine._buildIndex();
    engine.resultFilter = buildAttachmentFilter([{ kind: "file", name: "a.png", path: "C:/a.png" }], () => records);
    const byParent = await engine.search(`上传${SEARCH_BOUNDARY}补充说明`);
    ok(
      byParent.some((r) => r.item === uploader),
      "附件模式 + 父词命中：上传插件仍入围",
      JSON.stringify(byParent.map((r) => r.item.title))
    );
    const emptyParent = await engine.search(`${SEARCH_BOUNDARY}`);
    ok(
      emptyParent.some((r) => r.item === uploader),
      "附件模式 + 空父词：上传插件仍入围",
      JSON.stringify(emptyParent.map((r) => r.item.title))
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
