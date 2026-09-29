/**
 * 「最近添加」历史（Alt 条带数据源）纯逻辑测试。
 *
 * 覆盖契约（attachments.ts）：
 *   1. mergeRecentAttachments：新条目置顶 / attachmentKey 去重（反复添加
 *      只留一份并提到最前）/ 封顶 cap / 批内保持传入顺序 / 非法条目剔除
 *   2. 与 mergeAttachments 相反的顺序语义：历史按「新 → 旧」排列
 *   3. 条带排除「已进输入框的附件」：点过的条目不在条带重复出现，
 *      移除附件后又会回到条带（路径大小写/斜杠差异视为同一条）
 *
 * 用法: node test/recent-attachments.test.mjs
 */
import {
  attachmentKey,
  mergeRecentAttachments,
  RECENT_ATTACH_KEY,
  RECENT_ATTACH_CAP,
} from "../src/lib/plugins/attachments.ts";

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

const file = (name, path = `C:/docs/${name}`) => ({ kind: "file", name, path });
const folder = (name, path = `C:/docs/${name}`) => ({ kind: "folder", name, path });

/* ---------- 键与上限常量 ---------- */
{
  ok(RECENT_ATTACH_KEY === "RECENT_ATTACH_KEY", "storage 键与缓存面板蓝图一致（裸键名）");
  ok(RECENT_ATTACH_CAP === 30, "默认上限 30 条");
}

/* ---------- 条带排除「已在输入框里的附件」 ---------- */
{
  // 与 App.vue 的 stripFiles 计算属性同一套键运算：条带只列还没进输入框的
  const strip = (recent, attached) => {
    const keys = new Set(attached.map(attachmentKey));
    return recent.filter((e) => !keys.has(attachmentKey(e)));
  };

  const a = file("a.txt");
  const b = file("b.txt");
  const c = file("c.txt");
  // b 被点进输入框（成为附件）后，条带里不再出现 b
  {
    const shown = strip([a, b, c], [b]);
    ok(shown.map((e) => e.name).join(",") === "a.txt,c.txt", "点过的条目已进输入框，条带不再重复列出", JSON.stringify(shown));
  }
  // 附件里没有的条目照常列出（点之前）
  {
    const shown = strip([a, b, c], []);
    ok(shown.length === 3, "没有附件时条带列出全部历史条目");
  }
  // 路径只差大小写/斜杠，也视为同一条（不重复出现）
  {
    const shown = strip([file("a.txt", "C:\\Docs\\a.txt")], [file("a.txt", "c:/docs/a.txt")]);
    ok(shown.length === 0, "路径大小写/斜杠差异也视为同一条（不重复出现）");
  }
  // 把输入框里的 chip 删掉（附件集合不再含它）→ 条目回到条带
  {
    const shown = strip([a, b, c], []);
    ok(shown.map((e) => e.name).join(",") === "a.txt,b.txt,c.txt", "移除附件后条目回到条带");
  }
  // 无可选项的判定：条带为空就不该展开（showRecentStrip 的前置条件）
  {
    ok(strip([], []).length === 0, "历史为空 → 无可选项，不展开");
    ok(strip([a, b], [a, b]).length === 0, "历史条目全在输入框里 → 无可选项，不展开");
    ok(strip([a, b], [a]).length === 1, "还剩一条未附加 → 有可选项，可展开");
  }
}

/* ---------- 新增置顶 / 批内顺序 ---------- */
{
  const r1 = mergeRecentAttachments([], [file("a.txt"), file("b.txt")]);
  ok(r1.map((e) => e.name).join(",") === "a.txt,b.txt", "首批按传入顺序排列", JSON.stringify(r1));

  const r2 = mergeRecentAttachments(r1, [file("c.txt")]);
  ok(r2[0].name === "c.txt", "后添加的提到最前（新 → 旧）", JSON.stringify(r2));
  ok(r2.length === 3, "简单追加不丢旧条目");
}

/* ---------- attachmentKey 去重：反复添加只留一份并置顶 ---------- */
{
  const before = [file("a.txt"), file("b.txt"), file("c.txt")];
  // 大小写不同 + 斜杠方向不同 → 同一个 attachmentKey，必须去重
  const readded = { kind: "file", name: "A.TXT", path: "C:\\docs\\A.TXT" };
  const out = mergeRecentAttachments(before, [readded]);
  ok(out.length === 3, "同路径（大小写/斜杠差异）去重后仍是 3 条", JSON.stringify(out));
  ok(out[0].path === "C:\\docs\\A.TXT", "重新添加的条目置顶", JSON.stringify(out));
  ok(out.filter((e) => attachmentKey(e) === attachmentKey(readded)).length === 1, "去重后仅存一份");
}

/* ---------- 封顶 cap ---------- */
{
  const many = Array.from({ length: 30 }, (_, i) => file(`f${i}.txt`));
  const out = mergeRecentAttachments([], many);
  ok(out.length === RECENT_ATTACH_CAP, `30 条只留 ${RECENT_ATTACH_CAP} 条`, String(out.length));
  ok(out[0].name === "f0.txt" && out[out.length - 1].name === `f${RECENT_ATTACH_CAP - 1}.txt`, "裁掉的是最旧的尾部");

  // 旧历史已满时，新条目挤掉最旧一条
  const full = Array.from({ length: RECENT_ATTACH_CAP }, (_, i) => file(`old${i}.txt`));
  const out2 = mergeRecentAttachments(full, [file("new.txt")]);
  ok(out2.length === RECENT_ATTACH_CAP && out2[0].name === "new.txt", "满额后新条目挤入并置顶");
  ok(!out2.some((e) => e.name === `old${RECENT_ATTACH_CAP - 1}.txt`), "被挤掉的是最旧一条");

  // 自定义 cap 边界
  const out3 = mergeRecentAttachments([], many, 5);
  ok(out3.length === 5, "自定义 cap 生效");
}

/* ---------- 文件夹与非法条目 ---------- */
{
  const out = mergeRecentAttachments([], [{ kind: "weird", name: "x", path: "C:/x" }, folder("dir"), null, file("ok.txt")]);
  ok(out.length === 2 && out[0].kind === "folder", "非法 kind / null 条目被剔除", JSON.stringify(out));

  // 空输入幂等
  ok(mergeRecentAttachments([], []).length === 0, "空输入返回空数组");
  ok(mergeRecentAttachments(undefined, undefined).length === 0, "undefined 入参不抛错");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
