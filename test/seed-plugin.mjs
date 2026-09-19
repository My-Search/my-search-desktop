import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const pluginDir = new URL("../plugins/baidu-translate", import.meta.url).pathname;
const manifestText = readFileSync(`${pluginDir}/plugin.json`, "utf8");
const manifest = JSON.parse(manifestText);
const now = Date.now();

const record = {
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  author: manifest.author,
  description: manifest.description,
  homepage: manifest.homepage,
  icon: manifest.icon,
  manifest,
  dir: pluginDir,
  source: { kind: "folder", ref: pluginDir, dev: true },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  grants: [
    { permission: "ui.inlay", at: now, source: "install" },
  ],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
  updateAvailable: null,
};

// 写入 plugins/.seeded 标记文件（前端安装脚本会检测）
const seedPath = new URL("../plugins/.seeded-baidu-translate.json", import.meta.url).pathname;
writeFileSync(seedPath, JSON.stringify(record, null, 2));
console.log("种子文件已写入:", seedPath);
console.log("启动应用后进入「设置 → 插件」面板，选择「从目录挂载」并选择 plugins/baidu-translate 目录即可");
