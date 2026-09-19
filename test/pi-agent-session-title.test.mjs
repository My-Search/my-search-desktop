import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nameSessionFromFirstMessage } from "../plugins/pi-agent/backend/session-title.mjs";

function runtime(name = "", messages = []) {
  const names = [];
  return {
    title: "新对话",
    names,
    session: {
      messages,
      sessionManager: { getSessionName: () => name },
      setSessionName(value) { name = value; names.push(value); },
    },
  };
}

test("首次输入作为名称，合并多行空白并同步草稿标题", () => {
  const rec = runtime();
  nameSessionFromFirstMessage(rec, "  帮我修复搜索框\n  启动问题 🛠️  ");
  assert.equal(rec.title, "帮我修复搜索框 启动问题 🛠️");
  assert.deepEqual(rec.names, [rec.title]);
});

test("后续输入、发送失败后重试均不覆盖首次名称", () => {
  const rec = runtime();
  nameSessionFromFirstMessage(rec, "首次输入");
  nameSessionFromFirstMessage(rec, "失败后重试");
  rec.session.messages.push({ role: "user", content: "首次输入" });
  nameSessionFromFirstMessage(rec, "后续输入");
  assert.deepEqual(rec.names, ["首次输入"]);
});

test("保留自定义名称与已有历史会话", () => {
  for (const name of ["自定义标题", "新对话"]) {
    const rec = runtime(name);
    nameSessionFromFirstMessage(rec, "首次输入");
    assert.deepEqual(rec.names, []);
  }
  const history = runtime("", [{ role: "user", content: "历史消息" }]);
  nameSessionFromFirstMessage(history, "新的消息");
  assert.deepEqual(history.names, []);
});

test("空白输入不会命名，长输入和 Unicode 不被截断", () => {
  const rec = runtime();
  nameSessionFromFirstMessage(rec, " \n\t ");
  assert.deepEqual(rec.names, []);
  const text = "排查🛠️".repeat(100);
  nameSessionFromFirstMessage(rec, text);
  assert.equal(rec.title, text);
});

test("发送路径在 prompt 前命名，创建 UI 不再写入占位名", () => {
  const backend = readFileSync(new URL("../plugins/pi-agent/backend/index.mjs", import.meta.url), "utf8");
  assert.match(backend, /nameSessionFromFirstMessage\(rec, message\);\s*await session\.prompt\(message/);
  const ui = readFileSync(new URL("../plugins/pi-agent/ui/index.js", import.meta.url), "utf8");
  const create = ui.slice(ui.indexOf('ms.backend.call("createSession"'), ui.indexOf('if (!result?.session)'));
  assert.doesNotMatch(create, /title:\s*"新对话"/);
});
