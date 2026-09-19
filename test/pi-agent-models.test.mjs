/**
 * pi-agent 模型配置后端契约测试（真跑插件后端进程）。
 *
 * 覆盖「设置 → 模型配置」这一页要用到的三个 RPC，以及它们最容易被写坏的地方：
 *   1. listProviders 能区分「自定义」（models.json 里的，可编辑）与「内置」（只读）；
 *   2. saveProvider 写进 ~/.pi/agent/models.json，且**只动 providers**——
 *      文件里其它顶层键、别的提供商都要原样保留；
 *   3. 写盘前生成 models.json.bak（JSONC 注释重写后会丢，得留个退路）；
 *   4. 校验失败（非法 id / 缺 Base URL / 非法 API / 模型 ID 重复 / 高级字段类型错）
 *      一律拒绝且**不改文件**；
 *   5. keepApiKey：面板不回显密钥，所以「留空保存」不能把已有 apiKey 抹掉；
 *   6. deleteProvider 删得掉自定义的、删不掉内置的。
 *
 * 隔离：用临时 HOME/USERPROFILE，让 pi 的 agentDir 落在 tmp 里，
 * 全程不碰用户真实的 ~/.pi/agent。
 *
 * 前置：本机装了 pi（npm i -g @earendil-works/pi-coding-agent）。
 * 用法: node test/pi-agent-models.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "plugins", "pi-agent", "backend", "index.mjs");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/* ---------------- 起后端（隔离的 HOME） ---------------- */
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-"));
const agentDir = path.join(tmpRoot, ".pi", "agent");
const modelsPath = path.join(agentDir, "models.json");
await mkdir(agentDir, { recursive: true });

// 预置一份「用户原有配置」：一个自定义提供商 + 一个未知顶层键（模拟 pi 未来新增的配置）
const OTHER_PROVIDER = {
  baseUrl: "https://other.example/v1",
  api: "anthropic-messages",
  apiKey: "sk-other",
  models: [{ id: "other-1" }],
};
await writeFile(
  modelsPath,
  JSON.stringify({ providers: { OtherProv: OTHER_PROVIDER }, futureTopLevel: { keepMe: true } }, null, 2),
  "utf8"
);

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", () => {});

let seq = 0;
function call(method, params, timeoutMs = 60000) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
const readModels = async () => JSON.parse(await readFile(modelsPath, "utf8"));

function done() {
  notify("deactivate");
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 300);
}

try {
  const init = await call("init", { pluginId: "com.mysearch.pi-agent", dataDir: path.join(tmpRoot, "data") });
  if (!init.result?.hasPi) {
    console.log("跳过：本机没有可用的 pi ——", init.result?.piError || "未找到");
    done();
    await rm(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  }

  /* ============ 1. listProviders ============ */
  const lp = await call("listProviders", {});
  const list = lp.result;
  check("listProviders 成功", Boolean(list), JSON.stringify(lp.error || "").slice(0, 120));
  check("返回 agentDir 与 models.json 路径",
    list?.modelsPath === modelsPath, `${list?.modelsPath}`);
  check("agentDir 指向隔离的临时目录（没碰真实 ~/.pi）",
    String(list?.agentDir || "").startsWith(tmpRoot), String(list?.agentDir));
  check("supportedApis 列出 pi 支持的 4 种 API",
    Array.isArray(list?.supportedApis) && list.supportedApis.length === 4,
    JSON.stringify(list?.supportedApis));

  const customIds = (list?.custom || []).map((p) => p.id);
  check("自定义提供商来自 models.json", customIds.includes("OtherProv"), JSON.stringify(customIds));
  const other = (list?.custom || []).find((p) => p.id === "OtherProv");
  check("自定义提供商带回 baseUrl / api / 模型列表",
    other?.baseUrl === OTHER_PROVIDER.baseUrl && other?.api === "anthropic-messages" && other?.models?.length === 1,
    JSON.stringify({ baseUrl: other?.baseUrl, api: other?.api, n: other?.models?.length }));
  check("自定义提供商标记 builtin:false", other?.builtin === false);
  check("密钥只回布尔不回明文（面板不摊密钥）",
    other?.hasApiKey === true && other?.apiKey === undefined,
    JSON.stringify({ hasApiKey: other?.hasApiKey, apiKey: other?.apiKey }));

  const builtinIds = (list?.builtin || []).map((p) => p.id);
  check("内置提供商被列出（pi 自带目录）", builtinIds.length > 5, `共 ${builtinIds.length} 个`);
  check("自定义的提供商不会在内置里重复出现",
    !builtinIds.includes("OtherProv"), JSON.stringify(builtinIds.slice(0, 5)));
  const openai = (list?.builtin || []).find((p) => p.id === "openai");
  check("内置提供商带名称与模型数", Boolean(openai?.name) && openai?.modelCount > 0,
    JSON.stringify({ name: openai?.name, n: openai?.modelCount }));

  /* ============ 2. saveProvider（新增） ============ */
  const added = await call("saveProvider", {
    id: "DemoProv",
    provider: {
      name: "Demo Provider",
      baseUrl: "https://demo.example/v1",
      api: "openai-completions",
      apiKey: "sk-demo",
      models: [
        { id: "demo-1", name: "Demo One", contextWindow: 128000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
        { id: "demo-2", advanced: { cost: { input: 1, output: 2 } } },
      ],
      advanced: { compat: { supportsDeveloperRole: false } },
    },
  });
  check("saveProvider 新增成功", added.result?.ok === true, JSON.stringify(added.error || added.result));
  check("返回备份文件路径", String(added.result?.backupPath || "").endsWith("models.json.bak"),
    String(added.result?.backupPath || ""));

  const afterAdd = await readModels();
  const demo = afterAdd.providers?.DemoProv;
  check("新提供商写进了 models.json", Boolean(demo), JSON.stringify(Object.keys(afterAdd.providers || {})));
  check("模型基础字段落盘（含 reasoning / input / 窗口）",
    demo?.models?.[0]?.id === "demo-1" && demo.models[0].reasoning === true &&
    Array.isArray(demo.models[0].input) && demo.models[0].input.includes("image") &&
    demo.models[0].contextWindow === 128000,
    JSON.stringify(demo?.models?.[0]));
  check("模型级高级字段（cost）原样保留",
    demo?.models?.[1]?.cost?.output === 2, JSON.stringify(demo?.models?.[1]));
  check("提供商级高级字段（compat）原样保留",
    demo?.compat?.supportsDeveloperRole === false, JSON.stringify(demo?.compat));

  check("★ 原有提供商没被覆盖", Boolean(afterAdd.providers?.OtherProv), JSON.stringify(Object.keys(afterAdd.providers || {})));
  check("★ 文件里的未知顶层键原样保留",
    afterAdd.futureTopLevel?.keepMe === true, JSON.stringify(afterAdd.futureTopLevel));
  check("写盘前生成了 models.json.bak", await exists(modelsPath + ".bak"));

  /* ============ 3. 再次保存：幂等 + keepApiKey ============ */
  const resaved = await call("saveProvider", {
    id: "DemoProv",
    keepApiKey: true,
    provider: {
      name: "Demo Provider",
      baseUrl: "https://demo2.example/v1",   // 改 Base URL
      api: "openai-completions",
      models: [{ id: "demo-1" }],            // 删掉 demo-2
    },
  });
  check("二次保存成功", resaved.result?.ok === true, JSON.stringify(resaved.error || resaved.result));
  const afterResave = await readModels();
  check("改动生效（Base URL 已更新）",
    afterResave.providers.DemoProv.baseUrl === "https://demo2.example/v1",
    afterResave.providers.DemoProv.baseUrl);
  check("删掉的模型从文件里消失",
    afterResave.providers.DemoProv.models.length === 1, JSON.stringify(afterResave.providers.DemoProv.models));
  check("★ keepApiKey：留空保存不会抹掉已有密钥",
    afterResave.providers.DemoProv.apiKey === "sk-demo",
    JSON.stringify(afterResave.providers.DemoProv.apiKey));
  check("其它提供商仍然在", Boolean(afterResave.providers.OtherProv));

  /* ============ 4. 校验失败必须拒绝且不写文件 ============ */
  const before = await readFile(modelsPath, "utf8");
  const badCases = [
    ["非法提供商 ID", { id: "bad id!", provider: { models: [] } }],
    ["有模型但缺 Base URL", { id: "NoUrl", provider: { api: "openai-completions", models: [{ id: "m" }] } }],
    ["非法 API 类型", { id: "BadApi", provider: { baseUrl: "https://a/v1", api: "nope", models: [{ id: "m" }] } }],
    ["模型缺 ID", { id: "NoModelId", provider: { baseUrl: "https://a/v1", api: "openai-completions", models: [{}] } }],
    ["模型 ID 重复", { id: "Dup", provider: { baseUrl: "https://a/v1", api: "openai-completions", models: [{ id: "m" }, { id: "m" }] } }],
    ["高级字段类型错（headers 不是对象）", { id: "BadAdv", provider: { baseUrl: "https://a/v1", api: "openai-completions", models: [{ id: "m" }], advanced: { headers: "nope" } } }],
    ["Base URL 不是 http(s)", { id: "BadUrl", provider: { baseUrl: "ftp://a/v1", api: "openai-completions", models: [{ id: "m" }] } }],
  ];
  for (const [label, params] of badCases) {
    const r = await call("saveProvider", params);
    check(`拒绝：${label}`, Boolean(r.error), JSON.stringify(r.result || r.error).slice(0, 90));
  }
  check("★ 校验失败后文件一字未改", (await readFile(modelsPath, "utf8")) === before);

  /* ============ 5. 坏掉的 models.json 不能被覆盖 ============ */
  const brokenPath = modelsPath;   // 直接用同一个文件模拟损坏
  await writeFile(brokenPath, "{ this is not json", "utf8");
  const onBroken = await call("saveProvider", {
    id: "X", provider: { baseUrl: "https://a/v1", api: "openai-completions", models: [{ id: "m" }] },
  });
  check("models.json 解析失败时拒绝写入", Boolean(onBroken.error), JSON.stringify(onBroken.result || onBroken.error).slice(0, 90));
  check("★ 解析失败时原文件保持不变", (await readFile(brokenPath, "utf8")) === "{ this is not json");
  await writeFile(modelsPath, before, "utf8");   // 复原

  /* ============ 6. deleteProvider ============ */
  const delBuiltin = await call("deleteProvider", { id: "openai" });
  check("内置提供商删不掉", Boolean(delBuiltin.error), JSON.stringify(delBuiltin.result || delBuiltin.error).slice(0, 90));

  const delGhost = await call("deleteProvider", { id: "NoSuchProvider" });
  check("不存在的提供商删不掉", Boolean(delGhost.error), JSON.stringify(delGhost.result || delGhost.error).slice(0, 90));

  const del = await call("deleteProvider", { id: "DemoProv" });
  check("删除自定义提供商成功", del.result?.ok === true, JSON.stringify(del.error || del.result));
  const afterDel = await readModels();
  check("★ 被删的提供商不在文件里了", !afterDel.providers.DemoProv, JSON.stringify(Object.keys(afterDel.providers || {})));
  check("★ 删除只影响目标（其它提供商还在）", Boolean(afterDel.providers.OtherProv));
  check("未知顶层键在删除后依然保留", afterDel.futureTopLevel?.keepMe === true);

  const lp2 = await call("listProviders", {});
  check("列表与文件同步（删掉的不再出现）",
    !(lp2.result?.custom || []).some((p) => p.id === "DemoProv"),
    JSON.stringify((lp2.result?.custom || []).map((p) => p.id)));

  /* ============ 7. 保存后新提供商的模型能被 registry 看到 ============ */
  await call("saveProvider", {
    id: "FreshProv",
    provider: { name: "Fresh", baseUrl: "https://fresh.example/v1", api: "openai-completions", models: [{ id: "fresh-1", name: "Fresh One" }] },
  });
  const allModels = await call("listModels", {});
  check("★ 保存后 listModels（底部模型切换器）能看到新提供商的模型",
    (allModels.result?.models || []).some((m) => m.provider === "FreshProv" && m.id === "fresh-1"),
    JSON.stringify((allModels.result?.models || []).filter((m) => m.provider === "FreshProv")));
} catch (e) {
  fail++;
  console.log("FAIL  未捕获异常 —", String(e?.stack || e));
} finally {
  done();
  await new Promise((r) => setTimeout(r, 400));
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
