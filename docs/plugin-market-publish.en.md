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
  "homepage": "https://github.com/you/my-plugin",
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

**id rules** (the most common pitfall):

- Must be **reverse-DNS**, at least two segments, e.g. `com.yourname.hello`
- Lowercase letters, digits, hyphens and dots only; no leading/trailing hyphen per segment
- Length <= 128; `core` / `host` / `system` are reserved
- **`com.mysearch.` and `mysearch.` are reserved official prefixes** — use your own domain

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
| `ms.input.listFolder(path)` | `file.read` | list a folder |
| `ms.net.fetch(url, opts)` | `net.fetch:<scope>` | HTTP request |
| `ms.system.writeClipboard(t)` | `clipboard.write` | write clipboard |
| `ms.system.openExternal(url)` | `system.openExternal` | open in system browser |
| `ms.env.list/pick()` | — | environment variables |
| `ms.backend.call(m, p)` | `backend.spawn` | call the backend process |
| `ms.log(level, ...)` | — | logging |
| `onSubKeyword(fn)` | — | receive `keyword : sub` forwarding |

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
