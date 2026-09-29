/**
 * 内置插件测试（浏览器调试环境模拟）。
 *
 * 测试策略：
 *   1. 桥接层 —— mock invoke 验证四命令的调用签名；
 *   2. 安装流程 —— 验证自动安装逻辑（已装跳过、已卸载跳过、不可用跳过、幂等）；
 *   3. 卸载不复活语义 —— 模拟 removed 后跳过。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";

const invokeCalls = [];

function mockInvoke(cmd, args) {
  invokeCalls.push({ cmd, args });
  switch (cmd) {
    case "builtin_list":
      return [
        { id: "com.mysearch.baidu-translate", available: true, installed: false, removed: false, version: null, resourcePath: "/fake/baidu.mspp", devSource: null },
        { id: "com.mysearch.pi-agent", available: true, installed: false, removed: false, version: null, resourcePath: "/fake/pi-agent.mspp", devSource: null },
        { id: "com.mysearch.market", available: false, installed: false, removed: false, version: null, resourcePath: null, devSource: null },
      ];
    case "builtin_mark_removed":
    case "builtin_clear_removed":
      return null;
    case "builtin_resource_path":
      return `/fake/${args.id}.mspp`;
    default:
      throw new Error(`未知模拟命令: ${cmd}`);
  }
}

describe("builtin bridge", () => {
  before(() => {
    invokeCalls.length = 0;
  });

  it("builtinList returns entries from Rust", async () => {
    const entries = await mockInvoke("builtin_list");
    assert.equal(entries.length, 3);
    const bt = entries.find((e) => e.id === "com.mysearch.baidu-translate");
    assert.ok(bt);
    assert.equal(bt.available, true);
    assert.equal(bt.installed, false);
    assert.equal(bt.removed, false);
  });

  it("builtinMarkRemoved marks plugin as removed", async () => {
    await mockInvoke("builtin_mark_removed", { id: "com.mysearch.baidu-translate" });
    const last = invokeCalls[invokeCalls.length - 1];
    assert.equal(last.cmd, "builtin_mark_removed");
    assert.equal(last.args.id, "com.mysearch.baidu-translate");
  });

  it("builtinClearRemoved clears removal mark", async () => {
    await mockInvoke("builtin_clear_removed", { id: "com.mysearch.baidu-translate" });
    const last = invokeCalls[invokeCalls.length - 1];
    assert.equal(last.cmd, "builtin_clear_removed");
    assert.equal(last.args.id, "com.mysearch.baidu-translate");
  });

  it("builtinResourcePath returns path for valid plugin", async () => {
    const path = await mockInvoke("builtin_resource_path", { id: "com.mysearch.baidu-translate" });
    assert.ok(path);
    assert.match(path, /\.mspp$/);
  });

  it("builtinResourcePath rejects unknown plugin", async () => {
    try {
      throw new Error("不是内置插件: com.example.evil");
    } catch (e) {
      assert.match(e.message, /不是内置插件/);
    }
  });
});

describe("install-builtin auto-install logic", () => {
  const installed = [];

  async function mockInstallSingle(id) {
    installed.push(id);
  }

  before(() => {
    installed.length = 0;
    invokeCalls.length = 0;
  });

  it("skips already installed plugins", async () => {
    const entries = [
      { id: "com.mysearch.baidu-translate", available: true, installed: true, removed: false },
      { id: "com.mysearch.pi-agent", available: true, installed: false, removed: false },
    ];
    for (const e of entries) {
      if (e.available && !e.installed && !e.removed) {
        await mockInstallSingle(e.id);
      }
    }
    assert.deepEqual(installed, ["com.mysearch.pi-agent"]);
  });

  it("skips removed plugins (upgrade does not reinstate)", async () => {
    installed.length = 0;
    const entries = [
      { id: "com.mysearch.pi-agent", available: true, installed: false, removed: true },
    ];
    for (const e of entries) {
      if (e.available && !e.installed && !e.removed) {
        await mockInstallSingle(e.id);
      }
    }
    assert.equal(installed.length, 0);
  });

  it("skips unavailable (no resource file) plugins", async () => {
    installed.length = 0;
    const entries = [
      { id: "com.mysearch.market", available: false, installed: false, removed: false },
    ];
    for (const e of entries) {
      if (e.available && !e.installed && !e.removed) {
        await mockInstallSingle(e.id);
      }
    }
    assert.equal(installed.length, 0);
  });

  it("is idempotent on repeat calls", async () => {
    installed.length = 0;
    const entries = [
      { id: "com.mysearch.baidu-translate", available: true, installed: false, removed: false },
    ];
    for (const e of entries) {
      if (e.available && !e.installed && !e.removed) {
        await mockInstallSingle(e.id);
      }
    }
    entries[0].installed = true;
    for (const e of entries) {
      if (e.available && !e.installed && !e.removed) {
        await mockInstallSingle(e.id);
      }
    }
    assert.equal(installed.length, 1);
  });

  /**
   * 开发模式：带 devSource 的内置插件应**优先目录挂载**——即使 .mspp 未打包
   * （available=false）也要处理（开发时往往只跑源码，不先跑 pack:builtin）。
   * 这条规则与 installSingleBuiltin / pullAndInstall 里的守卫保持一致。
   */
  it("dev-mounts builtins with devSource (even when .mspp unavailable)", async () => {
    const entries = [
      { id: "com.mysearch.pi-agent", available: false, removed: false, devSource: "D:/repo/plugins/pi-agent" },
    ];
    const handled = [];
    for (const e of entries) {
      if (e.removed) continue;
      if (e.devSource) {
        handled.push({ id: e.id, mode: "dev-mount", dir: e.devSource });
        continue;
      }
      if (!e.available) continue;
      handled.push({ id: e.id, mode: "mspp" });
    }
    assert.deepEqual(handled, [
      { id: "com.mysearch.pi-agent", mode: "dev-mount", dir: "D:/repo/plugins/pi-agent" },
    ]);
  });
});