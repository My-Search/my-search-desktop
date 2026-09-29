/**
 * 剪贴板位图（无文件路径的图片）的**进程内**临时存储。
 *
 * 背景：截图工具 / 浏览器「复制图片」写进剪贴板的是位图（CF_DIB / image/png），
 * 没有文件系统路径。Rust 侧的 `clipboard_file_paths` 只认 CF_HDROP（带路径的
 * 文件），因此这类图片会落到 web 层兜底，拿到 `File` 却拿不到 `path`。而缩略图
 * 预览 `attachmentPreview` 必须走路径读文件 —— 于是图片退化成普通文件图标。
 *
 * 解决：把 web 层的 `File` 读成 data URL 存在这里，附件条目只带一个 `blobKey`
 * 指过来，渲染时直接从内存取图，彻底绕开路径。
 *
 * 为什么是**旁挂表**而不是把 dataURL 塞进 `AttachedEntry`：
 * 附件状态会进 `mergeAttachments` 去重、进 `storageSet` 落到 localStorage（JSON）。
 * dataURL 动辄几 MB，既不能序列化也不能参与去重比较。旁挂表让 entry 保持轻量、
 * 可序列化，只多一个字符串键。
 *
 * 生命周期：随会话结束自然释放；`releaseBlobImage` 在附件被移除时显式回收，
 * `gcBlobImages` 在附件列表变化时兜底清理孤儿（双保险，避免长会话内存增长）。
 */

/** blobKey → data URL（`data:image/png;base64,...`） */
const store = new Map<string, string>();

/** 单调递增序号：生成稳定的 blobKey，同一 File 只读一次 */
let seq = 0;

/** 该 mime 是否可能作为图片渲染（宽松判断：只挡明显不是图片的类型） */
function looksLikeImage(type: string): boolean {
  const t = String(type || "").toLowerCase();
  if (t.startsWith("image/")) return true;
  // 部分截图工具给不出 mime（空串）；空串放行，交由 FileReader 结果兜底
  return t === "";
}

/** `File` / `Blob` → data URL（Promise 化的 FileReader） */
function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取剪贴板图片失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 把一个剪贴板图片 Blob 读成 data URL 并登记，返回它的 blobKey。
 *
 * **await 后才返回 key**：调用方（onPaste）等它落定再把附件交给父层，这样
 * 渲染时 `getBlobImage(key)` 必定已有内容，`thumbOf` 保持纯读、无渲染期写入。
 * （读取通常几十毫秒，粘贴本身已是异步路径，不引入可感知延迟。）
 *
 * @returns blobKey；非图片类型或读取失败返回空串（调用方退回普通文件处理）
 */
export async function registerBlobImage(file: File | Blob): Promise<string> {
  if (!file || !looksLikeImage((file as File).type ?? "")) return "";
  let dataUrl = "";
  try {
    dataUrl = await readAsDataURL(file);
  } catch (e) {
    return "";
  }
  if (!dataUrl) return "";
  const key = `blob:${++seq}`;
  store.set(key, dataUrl);
  return key;
}

/** 取已就绪的 data URL；未就绪 / 已回收返回空串 */
export function getBlobImage(key: string | undefined): string {
  if (!key) return "";
  return store.get(key) ?? "";
}

/**
 * 兜底清理孤儿：附件列表变化时按「仍存活」的 blobKey 集合回收其余条目。
 * 与 `SearchBox.vue` 里清理缩略图缓存同一时机、同一意图——附件增删是唯一
 * 会让位图失效的事件，因此挂在那个 watch 上即可覆盖全部移除路径。
 */
export function gcBlobImages(aliveKeys: ReadonlySet<string>): void {
  for (const k of store.keys()) {
    if (!aliveKeys.has(k)) store.delete(k);
  }
}
