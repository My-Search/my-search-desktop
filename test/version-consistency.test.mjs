/**
 * 版本号一致性契约测试（以源码为断言对象）。
 *
 * 为什么需要：主程序「是否有新版本」的自检（`check_update`）曾经拿
 * `CARGO_PKG_VERSION`（Cargo.toml）当当前版本，而发版只升了 package.json +
 * tauri.conf.json，导致 Cargo.toml 停在旧版本 → 7.9.32 的包永远以为自己是
 * 7.9.31，反复提示「发现新版本 v7.9.32」，更新后也不消失。修复后要求三处版本
 * 严格一致、且 `check_update` 改读 tauri.conf.json（app.package_info()）的版本。
 *
 * 用法: node test/version-consistency.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

const pkg = JSON.parse(read("package.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");

function cargoVersion() {
  const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

const vPkg = pkg.version;
const vTauri = tauri.version;
const vCargo = cargoVersion();

ok(!!vPkg && !!vTauri && !!vCargo, "三处版本字段都能读到", `pkg=${vPkg} tauri=${vTauri} cargo=${vCargo}`);
ok(vPkg === vTauri, "package.json 与 tauri.conf.json 版本一致", `${vPkg} vs ${vTauri}`);
ok(vTauri === vCargo, "tauri.conf.json 与 Cargo.toml 版本一致", `${vTauri} vs ${vCargo}`);
ok(vPkg === vCargo, "package.json 与 Cargo.toml 版本一致", `${vPkg} vs ${vCargo}`);

// check_update 必须读 app.package_info().version（tauri.conf.json 的版本），
// 而不是 env!(CARGO_PKG_VERSION)——后者会在发版忘升 Cargo.toml 时漂移。
const librs = read("src-tauri/src/lib.rs");
ok(
  /async fn check_update\(app: tauri::AppHandle\)/.test(librs),
  "check_update 形参接收 AppHandle（用于读 package_info）"
);
ok(
  /let current = app\.package_info\(\)\.version\.to_string\(\);/.test(librs),
  "check_update 当前版本取自 app.package_info().version（tauri.conf.json）",
  "与关于页/安装包同源，不再漂移"
);
ok(
  !/let current = env!\("CARGO_PKG_VERSION"\)\.to_string\(\);/.test(librs),
  "check_update 不再用 CARGO_PKG_VERSION 判断当前版本"
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
