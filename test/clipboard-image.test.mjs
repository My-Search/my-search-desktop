/**
 * 剪贴板位图（无路径图片）粘贴修复的纯逻辑测试。
 *
 * 覆盖契约（对应「截图粘贴退化成普通文件」这个 bug 的修复）：
 *   1. blobKey → isPreviewImage 认定为图片（不受文件名/扩展名限制）
 *   2. blobKey → attachmentKey 唯一（同名截图不互相去重）
 *   3. mergeAttachments 保留 blobKey（合并后图片不丢）
 *   4. mergeRecentAttachments **剥离** blobKey（历史进 localStorage，不留悬空键）
 *   5. clipboard-image 旁挂表：登记→读取→GC 回收
 *
 * 用法: node test/clipboard-image.test.mjs
 */
import {
  attachmentKey,
  isPreviewImage,
  mergeAttachments,
  mergeRecentAttachments,
} from "../src/lib/plugins/attachments.ts";
import {
  gcBlobImages,
  getBlobImage,
  registerBlobImage,
} from "../src/lib/plugins/clipboard-image.ts";

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

/* ---------- 最小 FileReader 垫片（Node 没有 DOM FileReader） ---------- */
// 只实现 registerBlobImage 用到的 readAsDataURL/onload/onerror 契约：
// 读取时立即异步回调，把 Blob 的文本内容包成 data URL（测试里不是真图也无妨）。
globalThis.FileReader = class {
  readAsDataURL(blob) {
    queueMicrotask(async () => {
      try {
        const text = typeof blob.text === "function" ? await blob.text() : "";
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(
          text
        ).toString("base64")}`;
        this.onload?.();
      } catch (e) {
        this.error = e;
        this.onerror?.();
      }
    });
  }
};

/* ---------- 1. blobKey 视为图片 ---------- */
{
  // 截图兜底常见的裸名（无扩展名）——按扩展名判不出图片，但有 blobKey 就是图片
  ok(isPreviewImage({ kind: "file", name: "image", blobKey: "blob:1" }), "blobKey → 图片");
  ok(
    isPreviewImage({ kind: "file", name: "截图", blobKey: "blob:2" }),
    "blobKey 无扩展名 → 图片"
  );
  ok(
    !isPreviewImage({ kind: "file", name: "image" }),
    "无 blobKey 无扩展名 → 不是图片"
  );
  ok(
    !isPreviewImage({ kind: "folder", name: "dir", blobKey: "blob:3" }),
    "文件夹即使有 blobKey 也不预览"
  );
  // 原有扩展名判据不受影响（回归）
  ok(isPreviewImage({ kind: "file", name: "a.PNG" }), "扩展名判据仍生效（回归）");
}

/* ---------- 2. blobKey → 唯一键 ---------- */
{
  const a = { kind: "file", name: "image.png", path: "", blobKey: "blob:10" };
  const b = { kind: "file", name: "image.png", path: "", blobKey: "blob:11" };
  ok(attachmentKey(a) !== attachmentKey(b), "同名不同 blobKey → 不同键");
  ok(
    attachmentKey(a) !== attachmentKey({ kind: "file", name: "image.png", path: "" }),
    "有 blobKey 与无 blobKey 的裸名条目不冲突"
  );
}

/* ---------- 3. mergeAttachments 保留 blobKey ---------- */
{
  const merged = mergeAttachments(
    [],
    [{ kind: "file", name: "image", path: "", blobKey: "blob:20" }]
  );
  ok(merged.length === 1 && merged[0].blobKey === "blob:20", "合并保留 blobKey");
  // 同一键再去重
  const again = mergeAttachments(merged, [
    { kind: "file", name: "image", path: "", blobKey: "blob:20" },
  ]);
  ok(again.length === 1, "同 blobKey 合并去重");
}

/* ---------- 4. mergeRecentAttachments 剥离 blobKey ---------- */
{
  const recent = mergeRecentAttachments(
    [],
    [{ kind: "file", name: "image", path: "", blobKey: "blob:30" }]
  );
  ok(recent.length === 1, "历史仍收录该条目");
  ok(
    recent[0].blobKey === undefined,
    "历史剥离 blobKey（不写进 localStorage）",
    JSON.stringify(recent[0])
  );
}

/* ---------- 5. 旁挂表：登记 → 读取 → GC ---------- */
{
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const key = await registerBlobImage(png);
  ok(typeof key === "string" && key.startsWith("blob:"), "图片 Blob 登记返回 blobKey", key);
  const dataUrl = getBlobImage(key);
  ok(dataUrl.startsWith("data:image/png;base64,"), "读取到 data URL", dataUrl.slice(0, 40));

  // 非图片类型不登记
  const txt = new Blob(["hello"], { type: "text/plain" });
  ok((await registerBlobImage(txt)) === "", "非图片 Blob 不登记");

  // 空 mime 放行（部分截图工具给不出 mime）
  const noMime = new Blob([new Uint8Array([1, 2, 3])], { type: "" });
  const key2 = await registerBlobImage(noMime);
  ok(typeof key2 === "string" && key2.startsWith("blob:"), "空 mime Blob 也登记", key2);

  // GC：只保留存活的键
  gcBlobImages(new Set([key]));
  ok(getBlobImage(key) !== "", "GC 后存活键仍在");
  ok(getBlobImage(key2) === "", "GC 后孤儿键被回收");

  // 未知键返回空串
  ok(getBlobImage("blob:nope") === "", "未知键 → 空串");
  ok(getBlobImage(undefined) === "", "undefined 键 → 空串");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
