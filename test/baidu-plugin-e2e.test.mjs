/**
 * 百度翻译插件「实包实装」端到端测试（无 Tauri，用 IPC 模拟）。
 *
 * 验证用户提出的三条诉求，全部走**真实安装包** plugins/baidu-translate.zip：
 *   1. favicon 用指定源 `https://api.xinac.net/icon/?url=https://fanyi.baidu.com`
 *   2. 该条目**没有** [推荐] / [脚本] 标签（标题里只有纯文本）
 *   3. 图标左下角（图标内部）有统一角标（PLUGIN_BADGE_SVG），且角标图形与用户给的一致
 *
 * 用法: npm run build && node test/baidu-plugin-e2e.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/index.html" : u);
    if (!file.startsWith(dist)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到浏览器，跳过");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", "_chrome-profile-baidu-e2e");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
function S(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const {
  result: { sessionId },
} = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400)
    );
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------------- 真实百度翻译安装包 ---------------- */
const zipPath = path.join(root, "plugins", "baidu-translate.zip");
const pkgBase64 = readFileSync(zipPath).toString("base64");
const EXPECTED_ICON = "https://api.xinac.net/icon/?url=https://fanyi.baidu.com";

/**
 * 用户提供的角标 SVG（逐字复制，作为独立基准）。
 *
 * 这里**不复用** src/lib/assets.ts 里的 PLUGIN_BADGE_SVG：测试要验证的是
 * 「用户要的东西真的进了页面」，拿被测对象自己当基准就永远测不出改动偏差。
 */
const EXPECTED_BADGE_SVG =
  '<svg t="1789530520078" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="8552" width="200" height="200"><path d="M1024 601.6v319.926857s0 102.4-102.4 102.4H102.4c-102.4 0-102.4-102.4-102.4-102.4V102.4S0-0.073143 102.4-0.073143h819.2C1024-0.073143 1024 102.4 1024 102.4l0.073143 277.138286L1024 601.6zM950.857143 658.285714V292.498286 146.285714c0-51.273143-73.142857-73.216-73.142857-73.216H146.285714C95.085714 73.069714 73.142857 146.285714 73.142857 146.285714v731.428572s21.942857 73.142857 73.142857 73.142857h731.428572c51.2 0 73.142857-73.142857 73.142857-73.142857V658.285714z m-573.659429 52.150857s-92.379429 106.934857 136.411429 118.418286v38.546286S182.125714 930.742857 204.8 674.596571C212.992 583.094857 448.877714 373.76 448.877714 373.76L249.051429 203.117714h513.024s56.32-11.849143 56.32 53.394286v462.555429L590.262857 509.952 377.197714 710.436571z" fill="#999999" p-id="8553"></path></svg>';

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__pkg = ${JSON.stringify(pkgBase64)};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\\\fake\\\\baidu-translate.zip');
        if (cmd === 'plugin_read_local_base64') return Promise.resolve(window.__pkg);
        if (cmd === 'plugin_install') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          for (const f of (args.files || [])) fs[args.pluginId + '/' + f.path] = f.data;
          localStorage.setItem('__mock_fs', JSON.stringify(fs));
          return Promise.resolve('plugins/' + args.pluginId);
        }
        if (cmd === 'plugin_read_text') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const b64 = fs[args.pluginId + '/' + args.relPath];
          if (b64 == null) return Promise.reject('文件不存在: ' + args.relPath);
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return Promise.resolve(new TextDecoder('utf-8').decode(bytes));
        }
        if (cmd === 'plugin_list_files') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const prefix = args.pluginId + '/';
          return Promise.resolve(
            Object.keys(fs).filter(k => k.startsWith(prefix)).map(k => ({ path: k.slice(prefix.length), size: 0 }))
          );
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        return Promise.resolve(null);
      },
      transformCallback(cb, once) {
        const cbId = Math.random().toString(36).slice(2);
        window.__cbIds = window.__cbIds || {};
        window.__cbIds[cbId] = cb;
        return cbId;
      },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

/* ================= 1. 设置窗口：从文件安装真实包 ================= */
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(700);
await evalJs(`localStorage.clear(); 1`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1500);

await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(600);

await evalJs(`
  [...document.querySelectorAll('.page.plugins button')]
    .find(b => b.textContent.includes('从文件安装')).click()
`);
await sleep(800);
const dialogText = await evalJs(`document.querySelector('#msgText')?.textContent || ''`);
check("安装确认弹窗出现（认出百度翻译）", dialogText.includes("百度翻译"), dialogText.slice(0, 80));

await evalJs(`document.querySelector('#msgOk').click()`);
await sleep(1000);

const listText = await evalJs(`document.querySelector('.page.plugins .plugins-list')?.textContent || ''`);
check("插件面板出现「百度翻译」", listText.includes("百度翻译"), listText.slice(0, 60));
check(
  "安装全程无异常（回归：不再出现 DataView 越界）",
  !pageErrors.some((e) => /DataView|outside the bounds/.test(e)),
  pageErrors.slice(0, 2).join(" | ")
);

/* ================= 2. 搜索主窗口：真实插件项 ================= */
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1600);

// 输入插件声明的关键词（百度翻译 → "翻译"）
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus();
    el.value = '翻译';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })();
  1
`);
await sleep(900);

const liInfo = await evalJs(`JSON.stringify((() => {
  const li = [...document.querySelectorAll('#matchItems .resultItem')]
    .find(el => (el.textContent || '').includes('百度翻译'));
  if (!li) return null;
  const img = li.querySelector('.item-icon > img');
  const badge = li.querySelector('.plugin-badge');
  const badgeSvg = badge?.querySelector('svg');
  const b = badge?.getBoundingClientRect();
  const i = li.querySelector('.item-icon')?.getBoundingClientRect();
  return {
    titleText: (li.querySelector('.title')?.textContent || li.textContent || '').trim(),
    // 标题里的彩色标签块（[推荐] / [脚本] 都会渲染成 .tag 元素）
    tags: [...li.querySelectorAll('.title .tag, .title > .tag, .tag')].map(t => (t.textContent || '').trim()),
    imgSrc: img?.getAttribute('src') || '',
    hasBadge: !!badge,
    // 角标 DOM 的完整序列化：与用户给的 SVG 做全等比对（含 t / p-id 属性）
    badgeHtml: badgeSvg ? badgeSvg.outerHTML : '',
    // 位置：应在图标**左下角**，且完全落在图标方框内
    badgeAtLeftBottom: b && i ? (b.left + b.width / 2 < i.left + i.width / 2 && b.top + b.height / 2 > i.top + i.height / 2) : false,
    badgeInsideIcon: b && i ? (b.left >= i.left - 0.5 && b.top >= i.top - 0.5 && b.right <= i.right + 0.5 && b.bottom <= i.bottom + 0.5) : false,
    // 宿主补的 [可搜索] 标签占位（渲染成 .tag 元素）：角标不该和它/标题重叠
    titleLeft: (() => { const t = li.querySelector('.title'); return t ? t.getBoundingClientRect().left : 0; })(),
  };
})())`);
const li = JSON.parse(liInfo || "null");
check("搜索结果里出现百度翻译条目", li !== null, liInfo?.slice(0, 120) || "未找到");

if (li) {
  /* ---- 诉求 1：favicon 用指定源 ---- */
  check(
    "favicon src 为指定图标 API",
    li.imgSrc === EXPECTED_ICON,
    li.imgSrc || "(空)"
  );

  /* ---- 诉求 2：没有 [推荐] / [脚本] 标签 ---- */
  check(
    "标题中不含 [推荐] 标签",
    !li.titleText.includes("推荐") && !li.tags.some((t) => t.includes("推荐")),
    JSON.stringify(li.tags) + " / " + li.titleText.slice(0, 40)
  );
  check(
    "标题中不含 [脚本] 标签",
    !li.titleText.includes("[脚本]") && !li.tags.some((t) => t.includes("脚本")),
    JSON.stringify(li.tags)
  );
  // 插件项会被宿主补 [可搜索]（用于子搜索转发），这是预期内的唯一标签
  check(
    "标签集合仅含宿主补的 [可搜索]（无推荐/脚本）",
    li.tags.every((t) => t.includes("可搜索")),
    JSON.stringify(li.tags)
  );

  /* ---- 诉求 3：左下角统一角标（且不越出 favicon） ---- */
  check("图标上有统一角标", li.hasBadge === true);
  check(
    "角标 SVG 与用户提供的逐字一致（含 t / p-id 属性）",
    li.badgeHtml === EXPECTED_BADGE_SVG,
    li.badgeHtml === EXPECTED_BADGE_SVG
      ? `${li.badgeHtml.length} 字符全等`
      : `实际 ${li.badgeHtml.length} 字符 vs 期望 ${EXPECTED_BADGE_SVG.length} 字符\n        实际 ${li.badgeHtml.slice(0, 100)}\n        期望 ${EXPECTED_BADGE_SVG.slice(0, 100)}`
  );
  check("角标贴在图标左下角", li.badgeAtLeftBottom === true);
  check(
    "角标完全落在 favicon 范围内（没有外溢到图标外）",
    li.badgeInsideIcon === true,
    `inside=${li.badgeInsideIcon}`
  );

  // 截图：肉眼复核（左下角角标 + 自定义图标）
  const shot = await S(
    "Page.captureScreenshot",
    {
      format: "png",
      clip: await evalJs(`JSON.stringify((() => {
        const li = [...document.querySelectorAll('#matchItems .resultItem')]
          .find(el => (el.textContent || '').includes('百度翻译'));
        const r = li.getBoundingClientRect();
        return { x: r.x - 4, y: r.y - 4, width: Math.min(r.width + 8, 600), height: r.height + 8, scale: 2 };
      })())`).then((s) => JSON.parse(s)),
    },
    sessionId
  );
  const shotPath = path.join(root, "test", "_shot-baidu-plugin-item.png");
  await import("fs/promises").then((m) =>
    m.writeFile(shotPath, Buffer.from(shot.result.data, "base64"))
  );
  console.log("      截图:", shotPath);
}

check("全程无页面异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
