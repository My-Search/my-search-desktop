# Send Button Morph & Input Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate stop button with a send button that morphs into a stop button during agent execution, and disable the send button when input is empty.

**Architecture:** Two changes to the pi-agent plugin UI layer: (1) Remove the standalone stop button from `chat-body` and make the send button toggle between send/stop states with appropriate styling and behavior, (2) Add input validation to disable the send button and suppress Enter when the input is empty or whitespace-only. Both changes are purely in the plugin's `ui/` directory.

**Tech Stack:** HTML, CSS, vanilla JavaScript (plugin UI layer)

## Global Constraints

- Only modify files under `plugins/pi-agent/ui/` (detail.html, detail.css, index.js)
- Preserve all existing functionality: stop/abort logic, notification handlers, keyboard shortcuts
- The send button must remain in the same DOM position (`.input-toolbar > .toolbar-right`)
- The stop action must still call `stopAgent()` which calls `ms.backend.call("abort", ...)`

---

### Task 1: Remove standalone stop button from HTML

**Files:**
- Modify: `plugins/pi-agent/ui/detail.html:72-77`

**Interfaces:**
- Consumes: none
- Produces: removes the `#pi-stop-btn` element; all JS references to `stopBtn` will become `null` after this change (Task 2 replaces them)

- [ ] **Step 1: Remove the stop button HTML block**

Delete lines 72-77 in `detail.html`:
```html
      <!-- 停止按钮（agent 运行时显示） -->
      <button class="pi-stop-btn" id="pi-stop-btn" hidden title="停止 Agent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
        停止
      </button>
```

The `chat-body` should go directly from the opening tag to the "load more history" button.

---

### Task 2: Replace stopBtn DOM ref with sendBtn-based stop logic in index.js

**Files:**
- Modify: `plugins/pi-agent/ui/index.js:71` (remove `stopBtn` ref)
- Modify: `plugins/pi-agent/ui/index.js` (all `stopBtn` references → use `sendBtn` class toggling)

**Interfaces:**
- Consumes: `sendBtn` (existing DOM ref at line 73)
- Produces: `setSendButtonRunning(isRunning)` function that toggles send button visual state

- [ ] **Step 1: Remove `stopBtn` DOM reference**

Delete line 71:
```javascript
const stopBtn = $("pi-stop-btn");
```

- [ ] **Step 2: Add `setSendButtonRunning` helper function**

Add after the DOM refs section (after line 76), before the init function:

```javascript
/** 切换发送按钮的运行/空闲状态 */
function setSendButtonRunning(running) {
  if (running) {
    sendBtn.classList.add("running");
    sendBtn.title = "停止 Agent";
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  } else {
    sendBtn.classList.remove("running");
    sendBtn.title = "发送消息";
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
  }
}
```

- [ ] **Step 3: Update sendBtn click handler to check running state**

Replace line 1195:
```javascript
sendBtn.addEventListener("click", () => sendMessage(inputEl.value));
```
With:
```javascript
sendBtn.addEventListener("click", () => {
  if (sendBtn.classList.contains("running")) {
    stopAgent();
  } else {
    sendMessage(inputEl.value);
  }
});
```

- [ ] **Step 4: Replace all `stopBtn` references with `setSendButtonRunning()` calls**

In `sendMessage()` (around line 1065-1071), replace:
```javascript
  isSending = true;
  sendBtn.disabled = true;
  currentToolNodes = [];
  currentRunningSession = { projectPath: currentProject.path, sessionId: currentSessionId };
  if (stopBtn) stopBtn.hidden = false;
```
With:
```javascript
  isSending = true;
  setSendButtonRunning(true);
  currentToolNodes = [];
  currentRunningSession = { projectPath: currentProject.path, sessionId: currentSessionId };
```

In the `finally` block of `sendMessage()` (around line 1108-1113), replace:
```javascript
    isSending = false;
    sendBtn.disabled = false;
    if (stopBtn) stopBtn.hidden = true;
    currentRunningSession = null;
```
With:
```javascript
    isSending = false;
    setSendButtonRunning(false);
    currentRunningSession = null;
```

In `stopAgent()` (around line 1118-1155), replace the `stopBtn` blocks:
```javascript
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = "正在停止…";
  }
```
With:
```javascript
  sendBtn.disabled = true;
```

And at the end of `stopAgent()`, replace:
```javascript
  isSending = false;
  sendBtn.disabled = false;
  if (stopBtn) {
    stopBtn.hidden = true;
    stopBtn.disabled = false;
    stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>停止';
  }
  currentRunningSession = null;
```
With:
```javascript
  isSending = false;
  setSendButtonRunning(false);
  currentRunningSession = null;
```

In `chat:status` notification handler (around line 1018-1023), replace:
```javascript
  ms.backend.onNotification("chat:status", (params) => {
    if (params?.status === "running") showTyping();
    else if (params?.status === "idle") {
      removeTyping();
      if (stopBtn) stopBtn.hidden = true;
    }
  });
```
With:
```javascript
  ms.backend.onNotification("chat:status", (params) => {
    if (params?.status === "running") showTyping();
    else if (params?.status === "idle") {
      removeTyping();
      setSendButtonRunning(false);
    }
  });
```

In `chat:aborted` notification handler (around line 1040-1042), replace:
```javascript
    isSending = false;
    sendBtn.disabled = false;
    if (stopBtn) { stopBtn.hidden = true; stopBtn.disabled = false; }
    currentRunningSession = null;
```
With:
```javascript
    isSending = false;
    setSendButtonRunning(false);
    currentRunningSession = null;
```

In `switchSession()` or other places that reference `stopBtn` (line 737), replace:
```javascript
	  if (stopBtn) { stopBtn.hidden = true; stopBtn.disabled = false; }
```
With:
```javascript
	  setSendButtonRunning(false);
```

- [ ] **Step 5: Remove old `stopBtn` event binding**

Delete lines 1243-1246:
```javascript
  // 停止按钮
  if (stopBtn) {
    stopBtn.addEventListener("click", stopAgent);
  }
```
(This is now handled by the sendBtn click handler above.)

---

### Task 3: Add send button running state CSS

**Files:**
- Modify: `plugins/pi-agent/ui/detail.css:934-952` (send-btn styles)
- Delete: `plugins/pi-agent/ui/detail.css:566-591` (old stop-btn styles)

**Interfaces:**
- Consumes: `.send-btn.running` class (applied by `setSendButtonRunning()` from Task 2)
- Produces: visual stop-button appearance when `.running` is present

- [ ] **Step 1: Delete old stop button CSS**

Delete lines 565-591 (the entire `.pi-stop-btn` block):
```css
/* ================= 停止按钮 ================= */
.pi-agent-container .pi-stop-btn { ... }
.pi-agent-container .pi-stop-btn:hover { ... }
.pi-agent-container .pi-stop-btn:active { ... }
.pi-agent-container .pi-stop-btn[hidden] { ... }
```

- [ ] **Step 2: Add `.send-btn.running` styles**

After the existing `.send-btn:disabled` rule (line 952), add:
```css
.pi-agent-container .send-btn.running {
  background-color: var(--accent-red);
  box-shadow: 0 2px 10px rgba(239, 68, 68, 0.3);
}
.pi-agent-container .send-btn.running:hover {
  background-color: #dc2626;
  transform: scale(1.05);
}
```

---

### Task 4: Disable send button when input is empty

**Files:**
- Modify: `plugins/pi-agent/ui/index.js:1194-1201` (bindEvents - input handler)

**Interfaces:**
- Consumes: `sendBtn`, `inputEl` (existing refs)
- Produces: send button disabled state synced with input content

- [ ] **Step 1: Add `updateSendButtonState` helper**

Add near `setSendButtonRunning` (from Task 2):
```javascript
/** 根据输入内容更新发送按钮可用状态 */
function updateSendButtonState() {
  if (sendBtn.classList.contains("running")) return;
  const hasText = inputEl.value.trim().length > 0;
  sendBtn.disabled = !hasText;
}
```

- [ ] **Step 2: Add input event listener in bindEvents**

After line 1202 (`inputEl.addEventListener("input", autoResizeInput);`), add:
```javascript
  inputEl.addEventListener("input", updateSendButtonState);
```

- [ ] **Step 3: Suppress Enter when input is empty**

Replace lines 1196-1201:
```javascript
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });
```
With:
```javascript
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (inputEl.value.trim().length > 0) {
        sendMessage(inputEl.value);
      }
    }
  });
```

- [ ] **Step 4: Call `updateSendButtonState` on init**

In the `init()` function, after `bindEvents()` (line 90), add:
```javascript
  updateSendButtonState();
```

- [ ] **Step 5: Call `updateSendButtonState` after clearing input in sendMessage**

In `sendMessage()`, after `inputEl.value = "";` and `autoResizeInput();` (lines 1057-1058), add:
```javascript
  updateSendButtonState();
```

---

### Task 5: Verify and commit

- [ ] **Step 1: Manual smoke test**

Open the pi-agent plugin in the app and verify:
1. Send button is disabled when input is empty
2. Send button enables when input has text
3. Enter does nothing when input is empty
4. Enter sends when input has text
5. Clicking send morphs button to red stop icon
6. Clicking stop morphs back to blue send icon
7. Agent abort still works correctly

- [ ] **Step 2: Commit**

```bash
git add plugins/pi-agent/ui/detail.html plugins/pi-agent/ui/detail.css plugins/pi-agent/ui/index.js
git commit -m "feat(pi-agent): merge stop button into send button, disable when empty"
```
