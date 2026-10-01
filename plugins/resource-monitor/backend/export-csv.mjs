/**
 * 资源监控插件 —— 导出 CSV（纯函数，可单测）。
 *
 * 输出长表（每行 = 某采样点某类别某程序），便于丢进 Excel / pandas 做透视：
 *
 *   time,iso,category,program,value,instances
 *   2026-09-30 18:01:05,2026-09-30T10:01:05.000Z,cpu,chrome.exe,43.6,5
 *
 * 另附一行汇总表在第二个导出函数里（系统级指标，见 buildSystemCsv）。
 * 值一律给**原始数值**（CPU 是 %，内存是字节，上传是字节/秒），
 * 单位只写在列名/表头注释里，避免 Excel 把带单位的文本当成字符串。
 */

/** CSV 单元格转义：含逗号 / 引号 / 换行时用双引号包裹并翻倍引号 */
export function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 一行 CSV */
export function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

/** 把毫秒时间戳格式化成 ISO（导出用，带时区） */
function isoOf(t) {
  try {
    return new Date(t).toISOString();
  } catch {
    return "";
  }
}

/** 本地可读时间（Excel 友好） */
function localOf(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 构造 Top 榜长表 CSV。
 * @param {Array} points 环形缓冲的采样点
 * @param {number} topK 每类别每拍最多导出多少名（默认取该点实际长度，通常 ≤ topN）
 * @returns {string} CSV 文本（含 BOM，Excel 打开中文不乱码）
 */
export function buildTopCsv(points, topK = 0) {
  const header = csvRow(["time", "iso", "category", "program", "value", "instances"]);
  const lines = ["\uFEFF" + header];
  const cats = ["cpu", "mem", "up"];
  for (const p of points ?? []) {
    if (!p || !p.top || typeof p.top !== "object") continue;
    const t = Number(p.t) || 0;
    for (const cat of cats) {
      const arr = Array.isArray(p.top[cat]) ? p.top[cat] : [];
      const n = topK > 0 ? Math.min(topK, arr.length) : arr.length;
      for (let i = 0; i < n; i++) {
        const e = arr[i];
        if (!Array.isArray(e)) continue;
        lines.push(csvRow([localOf(t), isoOf(t), cat, e[0], e[1], e[2] != null ? e[2] : 1]));
      }
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * 构造系统级指标长表 CSV（每拍一行：整机 CPU / 内存 / 真实上传 / 真实下载）。
 * 列名带单位，值保持数字。
 */
export function buildSystemCsv(points) {
  const header = csvRow([
    "time", "iso",
    "cpu_pct", "mem_used_bytes", "mem_total_bytes",
    "net_up_Bps", "net_down_Bps",
  ]);
  const lines = ["\uFEFF" + header];
  for (const p of points ?? []) {
    if (!p || !Array.isArray(p.s)) continue;
    const t = Number(p.t) || 0;
    const s = p.s;
    lines.push(csvRow([
      localOf(t), isoOf(t),
      s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, s[4] ?? 0,
    ]));
  }
  return lines.join("\r\n") + "\r\n";
}

/** 导出文件名（含本地日期时间，便于多次导出区分） */
export function exportFilename(prefix, at = Date.now()) {
  const d = new Date(at);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
}
