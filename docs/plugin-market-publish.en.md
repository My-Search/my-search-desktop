# Plugin Development & Publishing Guide

> 中文版（默认）: [plugin-market-publish.md](./plugin-market-publish.md)

> A copy of this file lives in the market repository for third-party developers:
> https://github.com/My-Search/my-search-plugin-market/blob/main/docs/plugin-market-publish.en.md
> **After editing this file, push the copy as well** (keep them in sync).


This guide walks you through the whole process from scratch:
**write a plugin → debug locally → package → publish to the market**.

If you only want the publishing rules, jump to [Section 4](#4-package--publish).

---

## 1. What is a plugin

A plugin for "My Search" is a **directory** containing at least a `plugin.json`
manifest and a UI file. Users invoke it by typing its keyword in the search box.

A plugin can:

- register an entry in search results (invoked by keyword)
- provide a custom UI (HTML + JS, with host-injected `ms.*` APIs)
- read/write local storage, access the network, use the clipboard, read files
- spawn a backend process (Node/Python, etc.) and talk to it
- participate in `keyword : sub-keyword` secondary search

---

## 2. Writing a plugin from scratch

### 2.1 Directory layout

```
my-plugin/
├── plugin.json          # manifest (required, must be at root)
├── meta.json            # market display metadata (required for publishing)
├── icon.svg             # icon (optional)
└── ui/
    ├── detail.html      # UI entry (required)
    └── index.js         # UI script (optional)
```

### 2.2 The manifest `plugin.json`

```jsonc
{
  "id": "com.yourname.hello",        // required: reverse-DNS, globally unique
  "name": "Hello Plugin",            // required: <= 48 chars
  "version": "1.0.0",                // required: SemVer; must increase on release
  "apiVersion": 1,                   // required: plugin API version is 1
  "minAppVersion": "7.9.15",         // optional: hidden on older app versions
  "author": "Your Name",             // required
  "description": "One-line summary", // required
  "homepage": "https://github.com/you/my-plugin",  // optional: homepage (clickable in the market)
  "repository": "https://github.com/you/my-plugin", // optional: repo, preferred as the "Homepage" link
  "changelog": "Added: export to Markdown\nFixed: slow scan on large folders", // optional: THIS version's release notes
  "icon": "icon.svg",                // relative path / data: URI / http(s) URL
  "permissions": ["ui.inlay"],       // required: declare needed permissions
  "contributes": {
    "searchItem": {
      "title": "Hello Plugin",
      "desc": "Shown in the main search box",
      "keyword": "hello",            // typing this invokes the plugin
      "subSearch": false             // true = participates in "hello : sub" search
    },
    "detailView": {
      "entry": "ui/detail.html",     // required: UI entry
      "script": "ui/index.js",
      "mode": "inlay",
      "closeBehavior": "exit"        // or "minimize" to keep the session alive
    }
  }
}
```

**About the "Homepage" link and "release notes"**:

- `repository` (optional): your plugin's repository. The market card shows a **clickable
  Homepage** link below the description (opens in the system browser). If both `repository`
  and `homepage` are set, `repository` wins; only that one is shown (the settings panel
  likewise shows a single "Homepage" row). If neither is set, the client derives the repo
  from your download URL (`github.com/<owner>/<repo>/releases/download/...`); third-party
  plugins (one repo per plugin) also get it automatically — so the link works either way,
  but declaring it is more precise.
- `changelog` (optional): **this version's** release notes. When a user has your plugin
  installed and a newer version is available, the market card shows this text below the
  description so they can see what changed. Write just this version's changes (not a
  cumulative log); multi-line (`\n`) is supported, and the list clamps to 8 lines.
  Remember to bump `version` before packaging.

> Official plugins (source lives in this repo under `plugins/<dir>/`) point `repository`
> at the **source directory**, e.g.
> `https://github.com/My-Search/my-search-desktop/tree/master/plugins/<dir>`; the card's
> **Homepage** link points straight at it — the homepage *is* the source address, so the
> label no longer varies by URL shape.

**id rules** (the most common pitfall):

- Must be **reverse-DNS**, at least two segments, e.g. `com.yourname.hello`
- Lowercase letters, digits, hyphens and dots only; no leading/trailing hyphen per segment
- Length <= 128; `core` / `host` / `system` are reserved
- **`com.mysearch.` and `mysearch.` are reserved official prefixes** — use your own domain

#### (Optional) Declare a global shortcut action `contributes.shortcut`

Use `contributes.shortcut` to expose an "action type" in Settings → Shortcuts. It shows up
**only while your plugin is installed** and is removed on uninstall, so users never have to
hunt for the hotkey in code. `action` has two forms:

**A. A reserved host-native name** (`screenshot` / `clipboard`) — the executor lives in the
host; the plugin merely claims one of these capabilities:

```jsonc
"contributes": {
  "shortcut": {
    "action": "screenshot",            // reserved host name: screenshot / clipboard
    "title": "Screenshot (select + annotate)", // label shown in the action-type dropdown
    "defaultShortcut": "ctrl+alt+x"    // optional: default combo added when installed (skipped if taken)
  }
}
```

**B. Your own action name** (starts with a lowercase letter; only lowercase letters, digits,
`-` and `_`) — the executor lives **inside your plugin** (backend process + UI). When the user
presses the hotkey, the host opens/restores your plugin view and dispatches the action name to
your plugin script, which receives it via `ms.shortcuts.onAction`:

```jsonc
"contributes": {
  "shortcut": {
    "action": "record-toggle",         // local name (host builds plugin:<your-id>:record-toggle)
    "title": "Recording (start / stop)",
    "defaultShortcut": "ctrl+alt+r"
  }
}
```

```js
// ui/index.js — receive the action dispatched by the host
if (ms.shortcuts && typeof ms.shortcuts.onAction === "function") {
  ms.shortcuts.onAction("record-toggle", function () {
    // start / stop recording…
  });
}
```

> Notes:
> - Single object or array (same as `searchItem`); `title` is required, `defaultShortcut` optional.
> - The action name must not start with the reserved host prefix `plugin:` (rejected at install time).
> - Availability follows install state; a default key already taken by another action is skipped.
> - Host-native actions (`screenshot` / `clipboard`) are run by the host; a custom action must be
>   implemented by your script via `ms.shortcuts.onAction`, otherwise the host just warns
>   "plugin did not respond to action".

### 2.3 The UI `ui/detail.html`

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Hello Plugin</title></head>
<body>
  <div id="app">
    <h2>Hello, world</h2>
    <button id="btn">Click me</button>
    <p id="out"></p>
  </div>
  <script src="index.js"></script>
</body>
</html>
```

### 2.4 The script `ui/index.js`

The host injects an `ms` object; `ms.plugin.id` is your plugin id.

```js
document.getElementById("btn").addEventListener("click", async () => {
  await ms.store.set("lastClick", Date.now());   // needs `store`
  ms.ui.toast("Saved", "info");                  // needs `ui.notify`
  document.getElementById("out").textContent = "Saved";
  ms.ui.setHeight(200);                          // needs `ui.inlay`
});

ms.log("info", "plugin loaded");
```

### 2.5 Common APIs (`ms.*`)

Each API requires the matching permission in `permissions`, otherwise it throws.

| API | Permission | Description |
| --- | --- | --- |
| `ms.search.query(kw, limit)` | `search.read` | query search data |
| `ms.search.setInput(text)` | `search.write` | set the search box content |
| `ms.search.closeView()` | `search.write` | close the plugin view |
| `ms.ui.toast(text, type)` | `ui.notify` | show a toast |
| `ms.ui.setHeight(px)` | `ui.inlay` | adjust view height |
| `ms.store.get/set/remove/keys()` | `store` | local key-value storage |
| `ms.input.readFile(path)` | `file.read` | read a file (as data URL) |
| `ms.input.listFolder(path)` | `file.read` | list a folder (uncapped by default, returned once the scan ends) |
| `ms.input.listFolderStream(path, onBatch, opts)` | `file.read` | streaming folder listing: `onBatch(entries)` fires while scanning (incremental UI for huge trees); pair `opts.gen` with `ms.input.cancelListFolder(gen)` to abort anytime |
| `ms.input.cancelListFolder(gen)` | `file.read` | abort a listing generation: in-flight walks return early with what they collected (e.g. a Stop button) |
| `ms.input.fileIcons(entries)` | `file.read` | batch system file icons (Explorer-style; returns `{path: dataURL}`, misses omitted) |
| `ms.input.open(path)` / `ms.input.reveal(path)` | `file.read` | open with default app / reveal in file manager |
| `ms.sync.status()` | `sync` | read sync state (`{ enabled, status, lastSyncAt, lastError }`; no account/credential data) |
| `ms.sync.trigger()` | `sync` | run a data sync, returns the state after it settles |
| `ms.net.fetch(url, opts)` | `net.fetch:<scope>` | HTTP request |
| `ms.system.writeClipboard(t)` | `clipboard.write` | write clipboard |
| `ms.system.openExternal(url)` | `system.openExternal` | open in system browser |
| `ms.env.list/pick()` | — | environment variables |
| `ms.backend.call(m, p)` | `backend.spawn` | call the backend process |
| `ms.log(level, ...)` | — | logging |
| `onSubKeyword(fn)` | — | receive `keyword : sub` forwarding |

#### About data sync (`sync`)

`ms.sync.*` drives **the user's own cloud backup** (WebDAV today), and the unit of
sync is the *whole* backup — settings, subscriptions, every installed plugin and
their data — **not** just your plugin's slice. So:

- It is desktop-only. When the user has not configured and enabled sync in
  *Settings → Backup & Sync*, `status().enabled` is `false` and `trigger()` throws —
  degrade gracefully.
- `trigger()` is **async and potentially slow** (it moves the whole backup); do not
  block your UI on it. Failures come back as `status: "error"` + `lastError` in the
  return value, **not** as a thrown exception.
- Users see a **dedicated data-sync notice** when installing your plugin (spelling
  out the blast radius), so request `sync` only when the feature truly needs it.
- The permission is source-agnostic: the host natively implements WebDAV only, but
  future sync backends reuse the same `sync` permission and APIs — your manifest
  will not need to change.

### 2.6 Reference implementations

Real plugins you can copy from:

- **`plugins/file-search/`** — smallest pure-frontend plugin, best starting point
- **`plugins/pi-agent/`** — full example with backend, env vars and theming
- **`plugins/com.zhuangjie.github-upload/`** — third-party naming example

---

## 3. Local debugging

Mount the plugin directory into the app (no packaging needed, changes apply instantly):

1. In the plugin settings panel choose "mount from directory" and point to your plugin dir
2. The app writes a `.dev-source` marker file
3. Editing `ui/**` reloads automatically; editing `plugin.json` re-reads the manifest

---

## 4. Package & publish

### 4.1 Packaging

Build the `.mspp` with the official packer (it is a ZIP; the host uses the *same*
implementation, so anything it produces is guaranteed installable):

```bash
node test/pack-plugin.mjs your-plugin-dir -o dist/com.yourname.hello.mspp
```

The packer strictly validates before packing:

- manifest validity (id/version/permissions…)
- non-empty directory
- declared entry files actually exist (`detailView.entry`, etc.)

It **fails hard** if validation fails — this prevents shipping a broken UI.
Consider running it in your own CI.

### 4.2 `meta.json` (market display metadata)

```json
{
  "categories": ["tools"],
  "tags": ["hello", "demo"]
}
```

- **`categories` is required and must be a non-empty array** (missing => build failure)
- `tags` are matched by in-market search
- `meta.json` is **not** included in the distributed `.mspp` (the packer excludes it)

### 4.3 Publishing a Release (third-party)

One repository holds **one plugin**. Rules:

| Rule | Requirement |
| --- | --- |
| Release tag | **must equal your plugin id** (e.g. `com.yourname.hello`) |
| Asset name | **must be `<plugin-id>.mspp`**, same as the tag |
| Manifest id | The `id` in `plugin.json` must match the tag (we download and verify) |
| Version | taken from the `version` field in `plugin.json`; just increase it |
| Tag stability | **must stay stable**; do not create a new tag per version |

```bash
# first release
gh release create com.yourname.hello \
  --title "Hello Plugin v1.0.0" \
  dist/com.yourname.hello.mspp

# new version: bump `version` in plugin.json, repackage, overwrite (same tag)
gh release upload com.yourname.hello dist/com.yourname.hello.mspp --clobber
```

### 4.4 Submit for listing

Open an issue containing only:

| Field | Description |
| --- | --- |
| **Repository** | `user/repo` (required) |
| Summary | one line about what the plugin does (optional) |

Once approved we add your repo to the market source list. **After that you only
publish in your own repo** — the index is rebuilt hourly, no need to contact us.

---

## 5. How to know if something went wrong

If your plugin does not conform, it will not enter the market, but the reason is
published in a public file:

```
https://github.com/My-Search/my-search-plugin-market/blob/main/index.error.json
```

Example content:

```json
{
  "generatedAt": "2026-09-24T10:43:35.874Z",
  "official-repo": [],
  "three-parties": [
    { "repo": "user/repo", "reason": "no Release found" }
  ]
}
```

Common reasons:

| Reason | What to do |
| --- | --- |
| No Release found | create a Release per the rules above |
| No tag matches the plugin-id rule | the tag must be your plugin id |
| Manifest id does not match the tag | fix the `id` in `plugin.json` |
| Manifest validation failed | fix the manifest as described |
| Package not downloadable | make sure the asset is `<plugin-id>.mspp` |

If your repository is deleted or made private, we automatically remove it from the
source list and stop processing it.

---

## 6. How we verify your package

1. Fetch your package according to the source list
2. **Unpack and validate the manifest** — run the full validator on the embedded
   `plugin.json` and check that its id matches the tag
3. **Compute sha256** — over the **actual package bytes**, never trusting self-reported values
4. Write the index — the client verifies this hash again before installing

In other words: **the hash is always computed by us**; you neither need to nor can
write it yourself.

---

## 7. Client-side security boundary

Download URLs are strictly validated by the client:

- must be **https**
- host may only be `github.com` (Release assets) or `raw.githubusercontent.com`
  (official plugin directory)
- port must be default or `443`
- URLs containing **userinfo are rejected** (blocks `github.com@evil.com` spoofing)
- **redirects are not followed automatically**: every hop is re-validated to prevent SSRF

So please host packages on **GitHub Releases**; do not use third-party file hosts.

---

## 8. Permissions

Only the following permissions may be declared:

| Permission | Group | Risk | Scope required |
| --- | --- | --- | --- |
| `search.read` / `search.write` | search | medium | no |
| `ui.inlay` / `ui.window` | ui | medium | no |
| `ui.command` / `ui.notify` | ui | low | no |
| `store` | data | low | no |
| `file.read` | data | high | no |
| `env.read` | data | high | **yes** (var name) |
| `sync` | data | high | no |
| `clipboard.write` / `clipboard.read` | device | low / high | no |
| `selection.read` | device | high | no |
| `system.openExternal` | device | medium | no |
| `net.fetch` | network | high | **yes** (URL pattern) |
| `backend.spawn` | danger | critical | no |
| `secret.read` | danger | critical | **yes** (secret name) |
| `plugin.install` | danger | critical | no |

- Scope syntax: `*`, `https://api.example.com/*`, `https://*.example.com/*`
- `permissions` and `optionalPermissions` must not overlap
- **Critical** permissions or a `*` scope force the user to **check each one
  individually** — request only what you need
- `sync` is high-risk but does not require individual checkboxes; plugins that
  request it do get a **dedicated data-sync notice** in the install dialog (stating
  that it touches the user's entire cloud backup) — request it only when truly needed

---

## 9. Deprecation

If a plugin is no longer maintained, the market marks it as deprecated:

- **automatic**: when the repository is archived on GitHub
- **manual**: contact us (used for official plugins)

Deprecated plugins **remain installable** (existing users may still depend on them);
only a badge and a note are shown. To stop distribution entirely, tell us separately.

---

## 10. Known limitations

- **Plugins are not signed yet**; integrity relies on the sha256 we compute. Do not
  replace a release asset with different content while keeping the same tag — the
  hash will mismatch and installation will be rejected.
- The index keeps only the **latest version** per plugin; the client offers no
  "install an older version / rollback". To roll back, **increase** the version in
  `plugin.json` (never decrease it, or the client will not treat it as an update).
- Do not delete assets currently referenced by a published Release, otherwise
  reinstalls will 404.
