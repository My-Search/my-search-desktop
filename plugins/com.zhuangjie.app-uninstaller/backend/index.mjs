/**
 * 软件卸载器 —— 后端（JSON-RPC over stdio，零 npm 依赖）
 *
 * 职责：
 *   - `list`            读取注册表 Uninstall 键，列出已安装软件（含 DisplayIcon
 *                       提取的 PNG 图标 data URL）；
 *   - `uninstall`       按注册表里的 UninstallString 启动软件自带的卸载程序，
 *                       卸载进程**退出后**发 `uninstall-finished` 通知（前端
 *                       收到后自动扫描残留）；
 *   - `uninstallForce`  强制卸载：taskkill 结束该软件的进程后仍走自带卸载程序
 *                       （杀进程只为解开文件占用，不替代卸载逻辑）；
 *   - `openLocation`    用资源管理器打开软件的安装目录；
 *   - `scan`            卸载后扫描残留（安装目录 / 快捷方式 / 注册表键）；
 *   - `clean`           只清理「本进程刚刚 scan 出来」的候选（按 scanId + id 取），
 *                       插件前端拿不到任意路径删除的能力。
 *
 * 平台：仅 Windows（注册表 + PowerShell）。其它平台返回可读错误，界面照常加载。
 *
 * 安全约束（有意为之）：
 *   1. 不执行前端传来的命令字符串。`uninstall` / `uninstallForce` 只接受软件 id，
 *      命令取自本进程刚读到的注册表条目；
 *   2. `clean` 只接受 scanId + 候选 id，删除路径来自本进程的 scanCache，
 *      并对盘符根目录、Windows 目录、Program Files 根等做兜底拒绝；
 *   3. 扫描候选按软件名/发布者做**归一化精确匹配**，不做宽泛的包含匹配，
 *      尽量少误报（例如不会把 Microsoft 整个目录当成某软件的残留）。
 */
import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ===================== JSON-RPC 基础 =====================

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { message: String(message) } });
}
function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function sendLog(level, message) {
  sendNotification("log", { level, message });
}

const IS_WIN = process.platform === "win32";

// ===================== PowerShell 调用 =====================

/**
 * 执行一段 PowerShell 脚本。
 *
 * 用 `-EncodedCommand`（UTF-16LE + base64）而不是 `-Command`：脚本里有中文、
 * 引号、反斜杠，走命令行拼接时极易被 cmd/PS 二次解析；编码后是一串 ASCII，
 * 完全绕开引号问题。
 */
function psExec(script, timeout = 60000) {
  if (!IS_WIN) {
    return Promise.reject(new Error("该功能仅支持 Windows"));
  }
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", timeout },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || err).trim();
          reject(new Error(detail || "PowerShell 执行失败"));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

/**
 * 执行一段 PowerShell 脚本，先通过**临时文件**把一段 base64 数据交给它。
 *
 * 为什么不用 `-EncodedCommand` 直接嵌数据：92 个软件的路径 base64 嵌进命令行
 * 会超 Windows 命令行长度上限（spawn ENAMETOOLONG，真实踩到）。
 * 为什么不走 stdin：本机环境下「Node spawn 的 PS 子进程读 stdin」存在静默
 * 挂起的怪癖（探针独立跑正常、放进后端进程就挂起，且无子进程、无回调——
 * 与环境笔记里「Node 对某些管道/端口静默挂起」同款）。临时文件两端都可靠：
 * Node 写文件零依赖，PS `Get-Content -Raw` 读文件零歧义；脚本本体保持固定
 * 大小，命令行里只带一个短路径。
 */
function psExecWithFile(script, dataBase64, timeout = 60000) {
  if (!IS_WIN) {
    return Promise.reject(new Error("该功能仅支持 Windows"));
  }
  const tmpPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "un-")),
    "payload.b64",
  );
  fs.writeFileSync(tmpPath, String(dataBase64 || ""), "utf8");
  // 脚本里通过 @@PAYLOAD@@ 标记拿路径（psLiteral 产出 base64 解码表达式，无引号问题）
  const full = script.replace(/@@PAYLOAD@@/g, psLiteral(tmpPath));
  const cleanup = () => {
    try {
      fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败无所谓（系统会回收） */
    }
  };
  return psExec(full, timeout).finally(cleanup);
}

/** 把任意字符串安全地嵌进 PowerShell 脚本（base64 → 运行时解码） */
function psLiteral(value) {
  const b64 = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;
}

// ===================== 软件图标（DisplayIcon → PNG data URL） =====================

/**
 * 图标缓存：DisplayIcon 归一化键 → data URL / ""（取不到也缓存，避免列表里
 * 几十个取不到图标的软件每次刷新都重跑一遍 PowerShell）。
 */
const iconCache = new Map();
const ICON_CACHE_MAX = 600;

/**
 * 从注册表 DisplayIcon 字段解析出可提取图标的 PE 文件路径。
 *
 * DisplayIcon 的常见形态：`C:\x\app.exe`、`C:\x\app.exe,0`、带引号
 * `"C:\x\app.exe",-5`、`C:\x\x.ico`；也有垃圾值（`msiexec.exe`、URL 等）。
 * 这里提取路径部分，只接受存在的 .exe/.ico/.dll；MSI 卸载项
 * （msiexec.exe /X{GUID}）没有独立 exe，返回 null（前端回落占位图标）。
 */
function displayIconPath(displayIcon, installLocation) {
  const raw = String(displayIcon || "").trim();
  let p = "";
  if (raw.startsWith('"')) {
    p = raw.slice(1).split('"')[0] || "";
  } else {
    // 无引号形态：路径本身几乎不含逗号（Windows 安装目录允许，但 DisplayIcon
    // 语境下逗号后必是图标索引），取最后一个逗号前段
    const i = raw.lastIndexOf(",");
    p = i > 0 ? raw.slice(0, i) : raw;
  }
  p = p.trim().replace(/^@/, "");
  // 相对路径（少数软件这么写）：按安装位置解析
  if (p && !/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith("\\\\")) {
    const loc = String(installLocation || "").trim();
    if (loc) p = loc.replace(/[\\/]+$/, "") + "\\" + p.replace(/^[\\/]+/, "");
  }
  if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(p)) return null;
  if (!/\.(exe|ico|dll)$/i.test(p)) return null;
  return p;
}

/**
 * 图标批量提取脚本：**固定大小**（不含任何软件路径），待取条目经临时文件以
 * base64 JSON 传入（`@@PAYLOAD@@` 标记处）——92 个软件的路径也塞得下
 * （`-EncodedCommand` 直接嵌数据会超命令行长度上限，spawn ENAMETOOLONG）。
 */
function iconBatchScript() {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$sig = @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
'@
$type = Add-Type -MemberDefinition $sig -Name UxIcon -Namespace Win32 -PassThru
$sig2 = @'
[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr h);
'@
$t2 = Add-Type -MemberDefinition $sig2 -Name UxIcon2 -Namespace Win32 -PassThru
# 条目：临时文件里的一行 base64（UTF8 JSON：[{key,path,index}]）
$entries = @()
$pl = @@PAYLOAD@@
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content -LiteralPath $pl -Raw).Trim()))
  $entries = $raw | ConvertFrom-Json
} catch { }
$out = @{}
foreach ($e in $entries) {
  try {
    $large = [IntPtr]::Zero
    $small = [IntPtr]::Zero
    $hr = $type::SHDefExtractIcon($e.path, [int]$e.index, 0, [Ref]$large, [Ref]$small, 32)
    if ($hr -lt 0 -or $large -eq [IntPtr]::Zero) { continue }
    $bmp = [System.Drawing.Bitmap]::FromHicon($large)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $out[$e.key] = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose(); $bmp.Dispose()
    $t2::DestroyIcon($large) | Out-Null
    $t2::DestroyIcon($small) | Out-Null
  } catch { }
}
$out | ConvertTo-Json -Depth 2 -Compress
`;
}

/**
 * 批量提取图标：一次 PowerShell 拉齐整页软件的图标（条目走临时文件）。
 * 成功 → data URL；失败 → ""（缓存住，前端回落占位符）。
 */
async function fetchIcons(entries) {
  if (!IS_WIN || !entries.length) return {};
  const payload = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
  try {
    const out = await psExecWithFile(iconBatchScript(), payload, 90000);
    const raw = String(out || "").trim();
    const map = raw ? JSON.parse(raw) : {};
    const result = {};
    for (const e of entries) {
      const v = map && typeof map === "object" ? map[e.key] : null;
      result[e.key] = typeof v === "string" && v.length > 0
        ? "data:image/png;base64," + v
        : "";
    }
    return result;
  } catch (e) {
    sendLog("warn", "图标提取失败: " + String(e?.message || e).slice(0, 200));
    return {};
  }
}

/** 解析 ConvertTo-Json 的输出：空串 → []，单对象 → [对象] */
function parseJsonArray(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  return parsed == null ? [] : [parsed];
}

// ===================== 已安装软件列表 =====================

/** 最近一次 list 的结果（id → 软件），uninstall 只认这里的 id */
const softwareCache = new Map();

/** 读取注册表 Uninstall 键的 PowerShell 脚本 */
function listScript() {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rows = New-Object System.Collections.ArrayList

function Add-UninstallKeys([string]$hiveName, [string]$viewName, [string]$subPath) {
  $hive = if ($hiveName -eq 'HKCU') { [Microsoft.Win32.RegistryHive]::CurrentUser } else { [Microsoft.Win32.RegistryHive]::LocalMachine }
  $view = if ($viewName -eq '32') { [Microsoft.Win32.RegistryView]::Registry32 } else { [Microsoft.Win32.RegistryView]::Registry64 }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
  if ($null -eq $base) { return }
  $root = $base.OpenSubKey($subPath)
  if ($null -eq $root) { return }
  foreach ($sub in $root.GetSubKeyNames()) {
    $k = $root.OpenSubKey($sub)
    if ($null -eq $k) { continue }
    $name = [string]$k.GetValue('DisplayName')
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ([int]$k.GetValue('SystemComponent') -eq 1) { continue }
    $release = [string]$k.GetValue('ReleaseType')
    if ($release -match 'Update|Hotfix|Security') { continue }
    if (-not [string]::IsNullOrWhiteSpace([string]$k.GetValue('ParentKeyName'))) { continue }
    $est = 0
    try { $est = [int64]$k.GetValue('EstimatedSize') * 1024 } catch { $est = 0 }
    $keyPath = $subPath + '\' + $sub
    $null = $rows.Add([pscustomobject]@{
      id = ''
      name = $name
      version = [string]$k.GetValue('DisplayVersion')
      publisher = [string]$k.GetValue('Publisher')
      installDate = [string]$k.GetValue('InstallDate')
      installLocation = [string]$k.GetValue('InstallLocation')
      uninstallString = [string]$k.GetValue('UninstallString')
      quietUninstallString = [string]$k.GetValue('QuietUninstallString')
      displayIcon = [string]$k.GetValue('DisplayIcon')
      estimatedSize = $est
      hive = $hiveName
      view = $viewName
      keyPath = $keyPath
    })
  }
}

Add-UninstallKeys 'HKLM' '64' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
Add-UninstallKeys 'HKLM' '32' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
Add-UninstallKeys 'HKCU' '64' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'

$rows | Sort-Object name | ConvertTo-Json -Depth 4 -Compress
`;
}

/** 解析 DisplayIcon 的图标序号（`,N` 后缀；无后缀 = 0） */
function displayIconIndex(displayIcon) {
  const raw = String(displayIcon || "").trim();
  if (raw.startsWith('"')) {
    const m = /",\s*(-?\d+)\s*$/.exec(raw);
    return m ? Number(m[1]) : 0;
  }
  const i = raw.lastIndexOf(",");
  if (i > 0) {
    const n = Number(raw.slice(i + 1).trim());
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 进程内图标缓存上限（超过清空：软件列表总量有限，正常达不到） */
function trimIconCache() {
  if (iconCache.size <= ICON_CACHE_MAX) return;
  iconCache.clear();
}

/** 读取并缓存已安装软件；id 由 hive/view/keyPath 稳定哈希得到 */
async function listSoftware() {
  if (!IS_WIN) throw new Error("软件卸载器仅支持 Windows");
  const out = await psExec(listScript(), 60000);
  sendLog("info", "list: 注册表读取完成，开始解析");
  const rows = parseJsonArray(out);
  softwareCache.clear();
  const items = [];
  for (const r of rows) {
    if (!r || !r.name) continue;
    const id = createHash("sha1")
      .update(`${r.hive}|${r.view}|${r.keyPath}`)
      .digest("hex")
      .slice(0, 16);
    const item = {
      id,
      name: String(r.name || ""),
      version: String(r.version || ""),
      publisher: String(r.publisher || ""),
      installDate: String(r.installDate || ""),
      installLocation: String(r.installLocation || ""),
      uninstallString: String(r.uninstallString || ""),
      quietUninstallString: String(r.quietUninstallString || ""),
      displayIcon: String(r.displayIcon || ""),
      estimatedSize: Number(r.estimatedSize) || 0,
      hive: String(r.hive || ""),
      view: String(r.view || ""),
      keyPath: String(r.keyPath || ""),
    };
    softwareCache.set(id, item);
    items.push(item);
  }
  // 图标：注册表 DisplayIcon → PNG data URL（取不到回落空串，前端显示占位）。
  // 放在 list 里做（而不是独立方法）：一次调用拿齐「列表 + 图标」，前端不用
  // 再发第二轮请求；失败不影响列表本身。带缓存：命中的不再重提（刷新不重复跑 PS）。
  try {
    const perItem = [];
    const todo = [];
    for (const it of items) {
      const pe = displayIconPath(it.displayIcon, it.installLocation);
      if (!pe) continue;
      const idx = displayIconIndex(it.displayIcon);
      const ck = pe.toLowerCase() + "#" + idx;
      perItem.push({ it, ck });
      if (!iconCache.has(ck)) todo.push({ key: ck, path: pe, index: idx });
    }
    sendLog("info", "list: 待提取图标 " + todo.length + " 个（缓存命中 " + (perItem.length - todo.length) + "），开始批量提取");
    if (todo.length) {
      const got = await fetchIcons(todo);
      for (const [k, v] of Object.entries(got)) iconCache.set(k, v);
      trimIconCache();
    }
    sendLog("info", "list: 图标提取完成");
    for (const { it, ck } of perItem) it.iconDataUrl = iconCache.get(ck) || "";
    for (const it of items) if (it.iconDataUrl === undefined) it.iconDataUrl = "";
  } catch (e) {
    sendLog("warn", "图标批量提取失败: " + String(e?.message || e).slice(0, 200));
    for (const it of items) it.iconDataUrl = "";
  }
  return items;
}

// ===================== 残留扫描 =====================

/** scanId → { createdAt, name, items }。只保留 30 分钟，避免内存里堆历史。 */
const scanCache = new Map();
const SCAN_TTL_MS = 30 * 60 * 1000;

function pruneScanCache() {
  const now = Date.now();
  for (const [id, entry] of scanCache) {
    if (now - entry.createdAt > SCAN_TTL_MS) scanCache.delete(id);
  }
}

/** 生成扫描残留的 PowerShell 脚本（参数走 base64，避免引号/中文被二次解析） */
function scanScript(item) {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$name = ${psLiteral(item.name)}
$publisher = ${psLiteral(item.publisher)}
$installLocation = ${psLiteral(item.installLocation)}
$hive = ${psLiteral(item.hive)}
$view = ${psLiteral(item.view)}
$keyPath = ${psLiteral(item.keyPath)}
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')

function Norm([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return '' }
  $x = $s.ToLowerInvariant()
  $x = $x -replace '\((x86|x64|32-bit|64-bit)\)', ' '
  $x = $x -replace '\bversion\b', ' '
  $x = $x -replace '\bv?\d+(\.\d+)+', ' '
  $x = $x -replace '\b(setup|installer|uninstall)\b', ' '
  $x = $x -replace '[\s\-_.]+', ''
  return $x.Trim()
}

$blocked = @('microsoft','windows','windowsapps','programfiles','programfilesx86','commonfiles','google','apple','intel','nvidia','amd','temp','cache','system32')
$targets = New-Object System.Collections.ArrayList
$n1 = Norm $name
if ($n1.Length -ge 2 -and ($blocked -notcontains $n1)) { [void]$targets.Add($n1) }
$n2 = Norm ($publisher + ' ' + $name)
if ($n2.Length -ge 2 -and ($blocked -notcontains $n2)) { [void]$targets.Add($n2) }
$targets = @($targets | Select-Object -Unique)

$found = New-Object System.Collections.ArrayList
$seen = @{}

function Add-Candidate([string]$kind, [string]$p, [string]$label) {
  if ([string]::IsNullOrWhiteSpace($p)) { return }
  if ($kind -eq 'registry') {
    $full = $p.Trim()
  } else {
    try { $full = [System.IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return }
  }
  if ([string]::IsNullOrWhiteSpace($full)) { return }
  $key = $kind + '|' + $full.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { return }
  $size = 0
  $count = 0
  if ($kind -eq 'dir') {
    try {
      $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue)
      $count = $files.Count
      if ($count -gt 20000) { $files = $files | Select-Object -First 20000 }
      $size = [int64]($files | Measure-Object -Property Length -Sum).Sum
    } catch { $size = 0 }
  } elseif ($kind -eq 'file') {
    try { $size = [int64](Get-Item -LiteralPath $full -ErrorAction SilentlyContinue).Length } catch { $size = 0 }
    $count = 1
  }
  $seen[$key] = $true
  $null = $found.Add([pscustomobject]@{ kind = $kind; path = $full; label = $label; size = $size; fileCount = $count })
}


function Add-DirIfExists([string]$p, [string]$label) {
  if ([string]::IsNullOrWhiteSpace($p)) { return }
  $full = $p.Trim().Trim('"')
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return }
  try { $full = [System.IO.Path]::GetFullPath($full).TrimEnd('\') } catch { return }
  $bad = @(($env:SystemDrive + '\'), $env:windir, $env:ProgramFiles, $pf86, $env:ProgramData, $env:LOCALAPPDATA, $env:APPDATA)
  foreach ($b in $bad) {
    if ([string]::IsNullOrWhiteSpace($b)) { continue }
    if ($full.ToLowerInvariant() -eq $b.TrimEnd('\').ToLowerInvariant()) { return }
  }
  # 不把 Windows 目录下的任何子目录当作某软件的残留
  $win = ($env:windir).TrimEnd('\').ToLowerInvariant() + '\'
  if ($full.ToLowerInvariant().StartsWith($win)) { return }
  Add-Candidate 'dir' $full $label
}

# 1) 注册表里记录的安装目录
Add-DirIfExists $installLocation '安装目录'

# 2) 常见安装位置下与软件名精确匹配的目录
$roots = @($env:ProgramFiles, $pf86, $env:ProgramData, $env:LOCALAPPDATA, $env:APPDATA)
foreach ($root in $roots) {
  if ([string]::IsNullOrWhiteSpace($root)) { continue }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($targets -contains (Norm $_.Name)) { Add-DirIfExists $_.FullName ('目录：' + $_.Name) }
  }
}

# 3) 桌面 / 开始菜单里的快捷方式（文件名归一化后与软件名匹配）
function Add-ShortcutMatches([string]$dir, [int]$depth) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  Get-ChildItem -LiteralPath $dir -File -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    $n = Norm ([System.IO.Path]::GetFileNameWithoutExtension($_.Name))
    foreach ($t in $targets) {
      if ($n -eq $t -or ($t.Length -ge 4 -and $n.StartsWith($t) -and ($n.Length - $t.Length) -le 12)) {
        Add-Candidate 'file' $_.FullName ('快捷方式：' + $_.Name)
        break
      }
    }
  }
  if ($depth -gt 0) {
    Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Add-ShortcutMatches $_.FullName ($depth - 1)
    }
  }
}
$desktop = [Environment]::GetFolderPath('Desktop')
$publicDesktop = Join-Path $env:PUBLIC 'Desktop'
$startUser = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startCommon = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
Add-ShortcutMatches $desktop 0
Add-ShortcutMatches $publicDesktop 0
Add-ShortcutMatches $startUser 3
Add-ShortcutMatches $startCommon 3


# 4) 注册表：卸载项 + 顶层软件键（HKCU/HKLM 64/32）
function RegistryPath([string]$hiveName, [string]$viewName, [string]$subPath) {
  if ($hiveName -eq 'HKCU') { return 'HKEY_CURRENT_USER\' + $subPath }
  $p = $subPath
  if ($p.StartsWith('SOFTWARE\')) { $p = $p.Substring(9) }
  if ($viewName -eq '32') { return 'HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\' + $p }
  return 'HKEY_LOCAL_MACHINE\SOFTWARE\' + $p
}
$unKey = RegistryPath $hive $view $keyPath
if (Test-Path -LiteralPath ('Registry::' + $unKey)) {
  Add-Candidate 'registry' $unKey '注册表：卸载项'
}

function Add-AppKeys([string]$rootPath) {
  if (-not (Test-Path -LiteralPath $rootPath)) { return }
  Get-ChildItem -LiteralPath $rootPath -ErrorAction SilentlyContinue | ForEach-Object {
    if ($targets -contains (Norm $_.PSChildName)) {
      Add-Candidate 'registry' $_.Name ('注册表：' + $_.PSChildName)
    }
  }
}
Add-AppKeys 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE'
Add-AppKeys 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node'
Add-AppKeys 'Registry::HKEY_CURRENT_USER\SOFTWARE'

$found | ConvertTo-Json -Depth 3 -Compress
`;
}

/**
 * 前端传来的软件对象只取白名单字段（不信任其余内容）
 */
function normalizeItem(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(o.id || "").slice(0, 64),
    name: String(o.name || "").slice(0, 200),
    publisher: String(o.publisher || "").slice(0, 200),
    installLocation: String(o.installLocation || "").slice(0, 1000),
    hive: String(o.hive || "").slice(0, 10),
    view: String(o.view || "").slice(0, 10),
    keyPath: String(o.keyPath || "").slice(0, 1000),
  };
}


/**
 * 扫描某个软件的残留。
 *
 * 返回的 `items[].id` 只在本次 scan 内有效；清理必须带 `scanId` 回来，
 * 由本进程按缓存校验——前端无法伪造一条「清空 C:\」的请求。
 */
async function scanResidue(rawItem) {
  if (!IS_WIN) throw new Error("残留扫描仅支持 Windows");
  const item = normalizeItem(rawItem);
  if (!item.name && !item.installLocation) throw new Error("缺少软件名称，无法扫描残留");

  const out = await psExec(scanScript(item), 180000);
  const rows = parseJsonArray(out);
  const items = [];
  for (const r of rows) {
    if (!r || !r.path) continue;
    const kind = String(r.kind || "");
    if (kind !== "dir" && kind !== "file" && kind !== "registry") continue;
    items.push({
      id: randomUUID(),
      kind,
      path: String(r.path),
      label: String(r.label || ""),
      size: Number(r.size) || 0,
      fileCount: Number(r.fileCount) || 0,
    });
  }

  pruneScanCache();
  const scanId = randomUUID();
  scanCache.set(scanId, { createdAt: Date.now(), name: item.name, items });
  return { scanId, name: item.name, items };
}

// ===================== 卸载 =====================

/**
 * 从注册表条目推断该软件「正在运行的可执行文件名」（供 taskkill 用）。
 *
 * 优先级：DisplayIcon 指向的 exe > 安装目录下的顶层 exe（取与软件名最接近的）。
 * 返回 null = 推断不出（此时强制卸载只能跳过杀进程，直接跑卸载程序）。
 */
function guessProcessImage(item) {
  const pe = displayIconPath(item.displayIcon, item.installLocation);
  if (pe && /\.exe$/i.test(pe)) {
    return path.win32.basename(pe);
  }
  const loc = String(item.installLocation || "").trim();
  if (loc && fs.existsSync(loc)) {
    try {
      const exe = fs
        .readdirSync(loc, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.exe$/i.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => {
          // 与软件名前缀最接近的排前（如「7-Zip」→ 7z.exe / 7zFM.exe 优先于卸载器）
          const anorm = a.toLowerCase().replace(/[^a-z0-9]/g, "");
          const bnorm = b.toLowerCase().replace(/[^a-z0-9]/g, "");
          const name = String(item.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const score = (n) => (name && n.startsWith(name.slice(0, 4)) ? 0 : 1);
          const du = /un(?:install|setup)/i.test(a) ? 1 : 0;
          const dv = /un(?:install|setup)/i.test(b) ? 1 : 0;
          return score(anorm) - score(bnorm) || du - dv || a.localeCompare(b);
        });
      return exe[0] || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 启动软件自带的卸载程序。
 *
 * 只接受软件 id：命令必须来自本进程 list 时读到的注册表条目。
 * 用 detached + unref 让卸载程序独立于插件后端运行——很多卸载程序会重启
 * 资源管理器或弹出多步向导，插件后端不应陪着它。
 *
 * `force` = 先 taskkill 结束该软件的进程（解开文件占用），再启动卸载程序。
 * 杀进程**只针对推断出的该软件自己的 exe**（按映像名精确匹配 /IM），不是
 * 乱杀；即便这样也只在用户明确点「强制卸载」时执行。
 *
 * 卸载进程退出后发 `uninstall-finished` 通知（带软件 id）：「普通/强制卸载
 * 完成后自动扫描残留」由前端在这条通知上触发，与手动扫描同一条路径。
 * 常见卸载器是**拉起子进程后立刻退出**的启动器（返回非 0 也可能已交付），
 * 所以只要进程退出就算「已结束」；发通知失败不影响卸载本身。
 */
async function uninstallSoftware(rawId, force = false) {
  if (!IS_WIN) throw new Error("软件卸载仅支持 Windows");
  const id = String(rawId || "");
  let item = softwareCache.get(id);
  if (!item) {
    await listSoftware();
    item = softwareCache.get(id);
  }
  if (!item) throw new Error("未找到该软件（列表可能已过期，请刷新后重试）");

  let command = item.uninstallString || item.quietUninstallString;
  if (!command) throw new Error("该软件没有提供卸载命令，请到「设置 → 应用」中卸载");

  // MSI 的 UninstallString 常写成 MsiExec.exe /I{GUID}（修改/安装入口），
  // 卸载必须换成 /X{GUID}；其它软件保持原命令不动。
  if (/msiexec(?:\.exe)?/i.test(command)) {
    command = command.replace(/\/i(?=\s*\{|\s*"|\s*$)/gi, "/X");
  }

  if (force) {
    const image = guessProcessImage(item);
    if (image) {
      try {
        await new Promise((resolve) => {
          // /F 强制结束、/IM 按映像名；T 只在映像确实是主程序时才有意义，
          // 这里保守只用 /F /IM。失败（进程本来没在跑）不算错误。
          execFile("taskkill.exe", ["/F", "/IM", image], { windowsHide: true }, () => resolve());
        });
        sendLog("info", `强制卸载「${item.name}」：已结束进程 ${image}`);
      } catch {
        /* 杀不掉（权限/不存在）：继续走卸载程序，由它自己处理占用 */
      }
      // 等文件句柄释放（杀进程后句柄释放通常在几百毫秒内）
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  const child = spawn(command, { shell: true, detached: true, stdio: "ignore", windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();

  const noticeId = randomUUID();
  // 监听卸载进程退出 → 通知前端「卸载已结束」（自动扫描残留的触发点）。
  // detached + unref 的进程退出事件仍会送达本进程（除非本进程先退出）。
  child.once("exit", () => {
    try {
      sendNotification("uninstall-finished", {
        id: noticeId,
        softwareId: item.id,
        name: item.name,
        forced: !!force,
      });
    } catch {
      /* 通知失败不影响卸载结果 */
    }
  });

  return {
    ok: true,
    started: true,
    name: item.name,
    command,
    finishedNotice: noticeId,
  };
}

/**
 * 用资源管理器打开软件的安装目录。
 *
 * 只接受软件 id、目录取自本进程的注册表条目（前端无法用它开任意路径）。
 * 目录不存在 / 未记录时返回可读错误；已存在的目录用 explorer /select 定位
 * 到目录本身（与「打开软件所在位置」的直觉一致）。
 */
async function openSoftwareLocation(rawId) {
  if (!IS_WIN) throw new Error("该功能仅支持 Windows");
  const id = String(rawId || "");
  let item = softwareCache.get(id);
  if (!item) {
    await listSoftware();
    item = softwareCache.get(id);
  }
  if (!item) throw new Error("未找到该软件（列表可能已过期，请刷新后重试）");

  const loc = String(item.installLocation || "").trim().replace(/^"|"$/g, "");
  if (!loc) throw new Error("该软件没有记录安装位置");
  if (!fs.existsSync(loc)) throw new Error("安装目录不存在（可能已被删除）：\n" + loc);

  const child = spawn("explorer.exe", [loc], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return { ok: true, path: loc, name: item.name };
}


// ===================== 清理残留 =====================

/** 规范化并校验目录：拒绝盘符根、Windows 目录及常见系统目录本身 */
function safeDirPath(p) {
  const full = path.resolve(String(p || ""));
  const parsed = path.parse(full);
  if (!parsed || full === parsed.root) throw new Error("拒绝删除磁盘根目录");
  const parts = full.split(path.sep).filter(Boolean);
  if (parts.length < 2) throw new Error("拒绝删除过浅的目录");

  const lower = full.toLowerCase().replace(/\\+$/, "");
  const guard = [
    process.env.windir,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.USERPROFILE,
  ]
    .filter(Boolean)
    .map((x) => path.resolve(x).toLowerCase().replace(/\\+$/, ""));
  if (guard.includes(lower)) throw new Error("拒绝删除系统目录");

  const winDir = path.resolve(process.env.windir || "C:\\Windows").toLowerCase();
  if (lower === winDir || lower.startsWith(winDir + path.sep)) {
    throw new Error("拒绝删除 Windows 目录内的内容");
  }
  return full;
}

/** 快捷方式：必须是 .lnk（删除前再做一次兜底校验） */
function safeShortcutPath(p) {
  const full = String(p || "");
  if (!/\.lnk$/i.test(full)) throw new Error("只允许清理快捷方式（.lnk）");
  return full;
}

/** 注册表键：只允许 HKCU/HKLM 的 SOFTWARE 子树，拒绝通配符 */
function safeRegistryPath(p) {
  const key = String(p || "").trim();
  if (!/^HKEY_(LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\/i.test(key)) {
    throw new Error("只允许清理 HKCU/HKLM 的 SOFTWARE 子树");
  }
  if (/[*?]/.test(key) || key.includes("..")) throw new Error("注册表键包含非法字符");
  if (/^HKEY_LOCAL_MACHINE\\SOFTWARE$/i.test(key) || /^HKEY_CURRENT_USER\\SOFTWARE$/i.test(key)) {
    throw new Error("拒绝删除 SOFTWARE 根键");
  }
  return key;
}

function regDelete(key) {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", ["delete", key, "/f"], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim() || "注册表删除失败"));
      else resolve();
    });
  });
}


/**
 * 清理选中的残留。
 *
 * `params.scanId` 必须是本进程 scan 时发出的 id；`ids` 只能命中该次扫描缓存的
 * 候选。删除前再做一次兜底校验（防路径穿越 / 误删系统目录）。
 */
async function cleanResidue(params) {
  if (!IS_WIN) throw new Error("残留清理仅支持 Windows");
  const scanId = String(params?.scanId || "");
  const entry = scanCache.get(scanId);
  if (!entry) throw new Error("扫描结果已过期，请重新扫描");

  const wanted = new Set((Array.isArray(params?.ids) ? params.ids : []).map((x) => String(x)));
  const results = [];
  for (const item of entry.items) {
    if (!wanted.has(item.id)) continue;
    try {
      if (item.kind === "dir") {
        fs.rmSync(safeDirPath(item.path), { recursive: true, force: true });
      } else if (item.kind === "file") {
        fs.unlinkSync(safeShortcutPath(item.path));
      } else if (item.kind === "registry") {
        await regDelete(safeRegistryPath(item.path));
      } else {
        throw new Error("未知残留类型");
      }
      results.push({ id: item.id, ok: true });
      item.cleaned = true;
    } catch (e) {
      results.push({ id: item.id, ok: false, error: String(e?.message || e) });
    }
  }
  entry.items = entry.items.filter((x) => !x.cleaned);
  return { ok: true, results, remaining: entry.items.length };
}

// ===================== 请求分发 =====================

async function handleRequest(method, id, params) {
  try {
    let result;
    switch (method) {
      case "init":
        result = { ok: true, platform: process.platform, supported: IS_WIN };
        break;
      case "list":
        result = { ok: true, items: await listSoftware() };
        break;
      case "uninstall":
        // force=true = 强制卸载（先结束进程再跑卸载程序）；也可走独立方法名
        result = await uninstallSoftware(params?.id, params?.force === true);
        break;
      case "uninstallForce":
        result = await uninstallSoftware(params?.id, true);
        break;
      case "openLocation":
        result = await openSoftwareLocation(params?.id);
        break;
      case "scan":
        result = await scanResidue(params?.item);
        break;
      case "clean":
        result = await cleanResidue(params || {});
        break;
      default:
        throw new Error(`未知方法: ${method}`);
    }
    sendResult(id, result);
  } catch (e) {
    sendError(id, e?.message || e);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (e) { return; }
  const { method, id, params } = msg;
  if (method === "deactivate") {
    sendLog("info", "正在退出...");
    rl.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (id != null) handleRequest(method, id, params);
});

rl.on("close", () => process.exit(0));
