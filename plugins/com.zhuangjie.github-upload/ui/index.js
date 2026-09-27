/**
 * GitHub 文件上传 - 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * 环境变量支持：
 *   每个配置输入框右侧有「变量」按钮，点击调用 ms.env.pick() 打开宿主的授权选择器。
 *   选中后填入 %NAME% 格式引用，上传时若有后端(bakcend.spawn)则 resolveRefs 替换为实际值。
 *   后端不可用时降级：%NAME% 原样作为字面量使用（但不会报错中断）。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  // ===== DOM =====
  var dom = {};
  var ids = ["gu-config-toggle","gu-config-panel","gu-status-text","gu-drop-zone","gu-file-input",
    "gu-preview","gu-drop-hint","gu-msg","gu-result","gu-token","gu-repo-combo","gu-repo-list",
    "gu-repo-input","gu-branch","gu-path","gu-dns","gu-compression","gu-compression-config",
    "gu-validate-token","gu-save-config","gu-progress","gu-progress-bar","gu-progress-text",
    "gu-progress-pct"];
  ids.forEach(function (id) { dom[id] = document.getElementById(id); });

  // ===== 状态 =====
  var reposCache = [];
  var isUploading = false;
  var backendOnline = false;

  /** 当前最后选中的文件 */ var lastFile = null;

  /**
   * 搜索框「上传 : yyy」里的 yyy —— 宿主经 onSubKeyword 推入，
   * 作为下一次上传的 commit message（插件自行决定是否消费）。
   */
  var pendingCommit = "";
  /** 已入队的附件键（path 或 name），防止重复上传同一批附加文件 */
  var attachmentSeen = {};

  // ===== 工具 =====
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function setMsg(html, cls) {
    dom["gu-msg"].innerHTML = html ? '<p class="' + (cls||"") + '">' + html + "</p>" : "";
    // 面板收起时的自动保存会「安全地」写一次盘（值没变），此时不弹提示；
    // 其余任何真正的状态消息都顺带弹一个 toast，让搜索框里的用户也知道结果。
    if (html && autoSaveEnabled && ms && ms.ui && typeof ms.ui.toast === "function") {
      var tmp = document.createElement("div");
      tmp.innerHTML = html;
      try { ms.ui.toast(String(tmp.textContent || "").slice(0, 160)); } catch (e) { /* 忽略 */ }
    }
  }
  function setResult(html) { dom["gu-result"].innerHTML = html || ""; }
  function setStatus(text) { dom["gu-status-text"].textContent = text || ""; }

  function hasRef(s) {
    return typeof s === "string" && /%[A-Za-z_][A-Za-z0-9_]*%/.test(s);
  }

  // ===== 进度条 =====
  /**
   * 为什么是「阶段进度」而不是「字节进度」：上传走宿主 ms.net.fetch，
   * 它不暴露 upload.onprogress 一类的事件（body 直接交出去），拿不到
   * 已发送字节数。于是把整条链路切成几个可观测的阶段，每进入一个阶段
   * 就把进度推到该阶段的下限，再用定时器朝上限缓缓逼近（永不越过上限），
   * 真正完成才推满 100%。用户看到的是「在动 + 卡在哪一步」，
   * 而不是一个会撒谎的百分比。
   */
  var progress = { stages: null, index: 0, value: 0, timer: null };

  function clearProgressTimer() {
    if (progress.timer) { clearInterval(progress.timer); progress.timer = null; }
  }

  function renderProgress() {
    var v = Math.max(0, Math.min(100, Math.round(progress.value)));
    if (dom["gu-progress-bar"]) dom["gu-progress-bar"].style.width = v + "%";
    if (dom["gu-progress-pct"]) dom["gu-progress-pct"].textContent = v + "%";
    if (dom["gu-progress"] && dom["gu-progress"].setAttribute) {
      dom["gu-progress"].setAttribute("aria-valuenow", String(v));
    }
  }

  /** 设定阶段序列并显示进度条（每次上传开始时调用） */
  function beginProgress(stages) {
    clearProgressTimer();
    progress.stages = stages;
    progress.index = -1;
    progress.value = 0;
    if (dom["gu-progress"]) dom["gu-progress"].style.display = "block";
    dom["gu-progress"].classList.remove("done");
    dom["gu-progress"].classList.remove("err");
    renderProgress();
  }

  /**
   * 进入某个阶段（stage.text 也用作状态栏文案）。
   * 同一阶段重复调用是幂等的，不会重置已推进的进度。
   */
  function setProgress(stage) {
    if (!progress.stages) return;
    var i = progress.stages.indexOf(stage);
    if (i < 0 || i < progress.index) return;
    var from = i === 0 ? 0 : (progress.stages[i - 1].to || 0);
    var to = stage.to || 100;
    progress.index = i;
    progress.value = Math.max(progress.value, from);
    if (dom["gu-progress-text"]) dom["gu-progress-text"].textContent = stage.text || "";
    setStatus(stage.text || "");
    renderProgress();

    // 阶段内缓动：每 120ms 吃掉剩余距离的一小部分，上限不超过 to-1
    clearProgressTimer();
    if (to <= from) return;
    progress.timer = setInterval(function () {
      var room = to - 1 - progress.value;
      if (room <= 0) { clearProgressTimer(); return; }
      progress.value += Math.max(0.5, room * 0.12);
      renderProgress();
    }, 120);
  }

  /** 结束：成功推满 100%，失败停在当前进度并标红（进度不会倒退或假装完成） */
  function endProgress(ok, text) {
    clearProgressTimer();
    if (ok) {
      progress.value = 100;
      renderProgress();
      if (dom["gu-progress"]) dom["gu-progress"].classList.add("done");
      if (dom["gu-progress-text"]) dom["gu-progress-text"].textContent = text || "上传完成";
    } else {
      if (dom["gu-progress"]) dom["gu-progress"].classList.add("err");
      if (dom["gu-progress-text"]) dom["gu-progress-text"].textContent = text || "上传失败";
    }
    var el = dom["gu-progress"];
    if (el) {
      // 成功/失败都留一会儿再收起：太快消失等于没告诉用户结果
      setTimeout(function () {
        if (el === dom["gu-progress"]) el.style.display = "none";
      }, ok ? 1200 : 4000);
    }
  }

  /** 阶段定义：to = 该阶段完成时的进度上限（0-100） */
  function uploadStages(isImage) {
    return [
      { text: "读取文件...", to: 12 },
      { text: isImage ? "压缩图片..." : "准备数据...", to: 28 },
      { text: "解析配置...", to: 40 },
      { text: "查询远端文件...", to: 62 },
      { text: "上传中...", to: 96 },
      { text: "完成", to: 100 }
    ];
  }

  /**
   * 解析后仍残留 %NAME% 时立刻抛错：把字面量 "%NAME%" 发给 GitHub 只会得到
   * 一句毫无指向的 401 Bad credentials，用户完全看不出是环境变量没解析。
   */
  function ensureResolved(values) {
    for (var i = 0; i < values.length; i++) {
      var m = /%([A-Za-z_][A-Za-z0-9_]*)%/.exec(String(values[i] == null ? "" : values[i]));
      if (m) {
        throw new Error(
          "环境变量 %" + m[1] + "% 未能解析：请确认 1) 「设置 → 环境变量」已定义该变量；" +
          "2) 已通过输入框旁「变量」按钮授权本插件使用它（env.read）；" +
          "3) 插件后台已启动（backend.spawn 已授权且启动成功，可在「设置 → 插件」查看状态）"
        );
      }
    }
    return values;
  }

  // ===== 环境变量选择器 (ms.env.pick) =====
  function bindEnvPicker(inputId, btn) {
    var input = document.getElementById(inputId);
    if (!input || !btn) return;
    if (typeof ms === "undefined" || !ms.env || typeof ms.env.pick !== "function") return;

    function updateMark() {
      if (hasRef(input.value)) {
        btn.classList.add("env-ref");
        btn.textContent = "已引用";
      } else {
        btn.classList.remove("env-ref");
        btn.textContent = "变量";
      }
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      ms.env.pick({ title: "选择环境变量", purpose: "用于填充 GitHub 配置项" }).then(function (picked) {
        if (!picked) return;
        if (picked.kind === "ref") {
          input.value = "%" + picked.name + "%";
        } else if (picked.kind === "literal") {
          input.value = picked.value;
        }
        // 程序改 value 不会触发 input 事件，手动补发让「变更即校验」等监听生效
        input.dispatchEvent(new Event("input", { bubbles: true }));
        updateMark();
      }).catch(function () {});
    });

    input.addEventListener("input", updateMark);
    updateMark();
  }

  // ===== 仓库：可输入过滤的下拉（combobox） =====
  /**
   * 一个输入框同时承担两件事：
   *   - 已校验出仓库列表时：输入即按子串过滤（owner 与 repo 名都参与匹配），
   *     上下键选择、回车/点击回填，回车同时提交（键盘流不用碰鼠标）；
   *   - 没有列表或用户不选时：输入框本身就是原来的「手填 owner/repo /
   *     %环境变量%」入口，值原样交给上传管线。
   *
   * 取代旧的两态切换（<select> 与输入框互相 display:none）：那个设计每次
   * 重建 options 都会丢选择，而且没法「输入过滤」——列表一长就只能滚动找。
   */
  var repoCombo = { open: false, filtered: [], active: 0, empty: true };
  /**
   * pickRepo 回填时置位：屏蔽 combobox 自己的 input 处理器。
   * 不屏蔽的话「选中 → 收起」会被补发的 input 事件立刻重新打开，
   * 点选完列表还挂在界面上，用户以为没选中。
   */
  var pickingRepo = false;

  function repoItems() {
    return reposCache.map(function (r) {
      return { id: r.fullName, name: r.fullName, sub: r.visibility === "private" ? "(私仓)" : "" };
    });
  }

  function filterRepos(q) {
    var all = repoItems();
    var kw = String(q == null ? "" : q).trim().toLowerCase();
    if (!kw) return all;
    // 子串匹配（不是前缀）：记不住 owner 时可以直接搜仓库名
    return all.filter(function (it) { return it.name.toLowerCase().indexOf(kw) >= 0; });
  }

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /** 仓库名高亮当前过滤词（所有 HTML 片段先 esc，避免仓库名里的 <> 注入） */
  function repoItemHtml(it, kw) {
    var name = it.name;
    if (kw) {
      var re = new RegExp("(" + escRe(kw) + ")", "ig");
      name = name.replace(re, function (m) { return "\u0001" + m + "\u0002"; });
    }
    name = esc(name).split("\u0001").join("<mark>").split("\u0002").join("</mark>");
    return name + (it.sub ? ' <span class="gu-repo-vis">' + esc(it.sub) + "</span>" : "");
  }

  function positionRepoList() {
    var input = dom["gu-repo-input"], list = dom["gu-repo-list"];
    if (!input || !list || !input.getBoundingClientRect) return;
    var r = input.getBoundingClientRect();
    if (!r.width) return; // 宿主未布局（桩环境 / 面板未显示）
    list.style.left = r.left + "px";
    list.style.top = (r.bottom + 2) + "px";
    list.style.width = r.width + "px";
  }

  /**
   * @param {{highlight?: boolean}} opts highlight=false 用于「已回填后失焦」——
   *   此时把输入框选成全文选中，用户再打字就直接替换，不必先删干净。
   */
  function openRepoList(opts) {
    var list = dom["gu-repo-list"];
    if (!list || !list.style) return;
    var kw = dom["gu-repo-input"].value.trim();
    repoCombo.filtered = filterRepos(kw);
    repoCombo.active = 0;
    repoCombo.open = true;

    var h = "";
    if (!reposCache.length) {
      h = '<div class="gu-repo-empty">' +
        (String(dom["gu-token"].value || "").trim()
          ? "正在校验 Token / 暂无可用仓库"
          : "填好 Token 后这里会列出可推送仓库；也可直接手填 owner/repo") +
        "</div>";
    } else if (!repoCombo.filtered.length) {
      h = '<div class="gu-repo-empty">没有匹配的仓库，可直接手填 owner/repo 上传到其他仓库</div>';
    } else {
      var rows = repoCombo.filtered.slice(0, 50); // 上限：100 个仓库也没必要全画出来
      rows.forEach(function (it, i) {
        h += '<div class="gu-repo-item' + (i === 0 ? " active" : "") + '" role="option" data-repo="' +
          esc(it.id) + '">' + repoItemHtml(it, kw) + "</div>";
      });
    }
    list.innerHTML = h;
    list.style.display = "block";
    // 没有任何可选项时列表只是个提示框：不给它挂 active 态（Enter 也不会选中它）
    repoCombo.empty = repoCombo.filtered.length === 0;
    if (dom["gu-repo-input"] && dom["gu-repo-input"].setAttribute) {
      dom["gu-repo-input"].setAttribute("aria-expanded", "true");
    }
    positionRepoList();
    if (opts && opts.highlight && dom["gu-repo-input"].select) {
      try { dom["gu-repo-input"].select(); } catch (e) { /* 桩环境无 select */ }
    }
  }

  function closeRepoList() {
    var list = dom["gu-repo-list"];
    if (!list || !list.style) return;
    repoCombo.open = false;
    list.style.display = "none";
    if (dom["gu-repo-input"] && dom["gu-repo-input"].setAttribute) {
      dom["gu-repo-input"].setAttribute("aria-expanded", "false");
    }
  }

  /** 高亮第 i 项（上下键移动用；纯 CSS class 切换，不重建列表） */
  function markRepoActive(i) {
    var list = dom["gu-repo-list"];
    if (!list || !list.querySelectorAll) return;
    var items = list.querySelectorAll(".gu-repo-item");
    for (var k = 0; k < items.length; k++) {
      if (k === i) items[k].classList.add("active");
      else items[k].classList.remove("active");
    }
    if (items[i] && items[i].scrollIntoView) {
      try { items[i].scrollIntoView({ block: "nearest" }); } catch (e) { /* 忽略 */ }
    }
  }

  /** 回填选中仓库：同时把分支切到该仓库的默认分支（用户不必再手动改） */
  function pickRepo(fullName) {
    dom["gu-repo-input"].value = fullName;
    closeRepoList();
    for (var i = 0; i < reposCache.length; i++) {
      if (reposCache[i].fullName === fullName) {
        dom["gu-branch"].value = reposCache[i].defaultBranch || "master";
        break;
      }
    }
    // 回填不发 input 事件 → 手动补发，让「变更即保存」等监听生效。
    // 但 combobox 自己的 input 处理器会把列表再打开（明明刚选中、刚收起），
    // 所以整个补发过程对 combobox 屏蔽掉——pickRepo 结束时主动关一次就够了。
    pickingRepo = true;
    try {
      dom["gu-repo-input"].dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      pickingRepo = false;
    }
    closeRepoList();
  }

  function handleRepoKey(e) {
    var key = e.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (!repoCombo.open) { openRepoList(); } else if (repoCombo.filtered.length) {
        var n = Math.min(repoCombo.filtered.length, 50);
        repoCombo.active = key === "ArrowDown"
          ? (repoCombo.active + 1) % n
          : (repoCombo.active - 1 + n) % n;
        markRepoActive(repoCombo.active);
      }
      e.preventDefault();
      return;
    }
    if (key === "Enter") {
      // 回车的语义完全取决于「此刻有没有高亮项」——列表里首个候选进入时就是
      // 高亮项，所以「打开配置 → 直接回车」默认选中最近推送的仓库（列表按
      // pushed_at 降序）。没有候选时才回落到「确认输入」（不拦事件）。
      // 反过来说：候选项永远清不掉。清空输入再回车仍会选中列表第一项，
      // 用户若想手填别的仓库，别按回车，直接输入/失焦即可。
      if (repoCombo.open && repoCombo.filtered.length) {
        var it = repoCombo.filtered[Math.min(repoCombo.active, repoCombo.filtered.length - 1)];
        if (it) pickRepo(it.id);
        e.preventDefault();
      }
      return;
    }
    if (key === "Escape") {
      if (repoCombo.open) {
        // Esc = 「我不想选」，而不是「随便给我选一个」：隐藏列表但显示当前
        // 输入框里的原文，然后回车不会再把高亮项塞进来。
        e.preventDefault();
        closeRepoList();
      }
      return;
    }
    if (key === "Tab") { closeRepoList(); }
  }

  /** 点击列表项：容器上用委托，避免每开一次列表就重挂一堆监听 */
  function bindRepoCombo() {
    var input = dom["gu-repo-input"], list = dom["gu-repo-list"];
    if (!input || !list) return;

    input.addEventListener("input", function () {
      if (pickingRepo) return; // 回填触发的 input，不是用户在打字
      openRepoList();
    });
    input.addEventListener("focus", function () { openRepoList({ highlight: true }); });
    input.addEventListener("keydown", handleRepoKey);
    input.addEventListener("blur", function () {
      // 点列表项的 mousedown 已 preventDefault，这里失焦即真失焦
      setTimeout(closeRepoList, 120);
    });

    list.addEventListener("mousedown", function (e) {
      if (e.preventDefault) e.preventDefault(); // 保住输入框焦点，否则 blur 先关列表
      var t = e.target;
      var item = t && t.closest ? t.closest(".gu-repo-item") : null;
      if (!item) return;
      var v = item.getAttribute("data-repo");
      if (v) pickRepo(v);
    });

    // 面板内滚动 / 宿主窗口尺寸变化 → 列表跟着输入框走（fixed 定位不会自动跟随）
    var panel = dom["gu-config-panel"];
    if (panel && panel.addEventListener) panel.addEventListener("scroll", function () {
      if (repoCombo.open) positionRepoList();
    });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("resize", function () { if (repoCombo.open) positionRepoList(); });
    }
    // 浮层不随宿主滚动容器走，所以点面板外一律收起（避免列表飘在别处）
    document.addEventListener("click", function (e) {
      if (!repoCombo.open) return;
      var t = e.target;
      if (input.contains && input.contains(t)) return;
      if (list.contains && list.contains(t)) return;
      closeRepoList();
    });
  }
  function backendCall(method, params) {
    if (!ms || !ms.backend || !ms.backend.call) return Promise.reject(new Error("后端不可用"));
    return ms.backend.call(method, params);
  }

  function tryInitBackend() {
    return backendCall("init").then(function (r) {
      if (r && r.ok) {
        backendOnline = true;
        // 尝试预填
        return backendCall("getConfig").then(function (cfg) {
          if (!cfg) return;
          if (cfg.userAndRepo && !dom["gu-repo-input"].value) dom["gu-repo-input"].value = cfg.userAndRepo;
          if (cfg.branch && !dom["gu-branch"].value) dom["gu-branch"].value = cfg.branch;
          if (cfg.path && !dom["gu-path"].value) dom["gu-path"].value = cfg.path;
          if (cfg.dns && !dom["gu-dns"].value) dom["gu-dns"].value = cfg.dns;
        }).catch(function () {});
      }
    }).catch(function () {
      backendOnline = false;
    });
  }

  // 解析 %NAME% 引用 -> 实际值
  function resolveRefs(texts) {
    if (!texts || !texts.length) return Promise.resolve(texts);
    var hasAny = texts.some(function (t) { return hasRef(t); });
    if (!hasAny) return Promise.resolve(texts);

    if (backendOnline) {
      return backendCall("resolveRefs", { texts: texts }).then(function (res) {
        if (res && res.resolved) {
          if (res.notFound && res.notFound.length) {
            setMsg("环境变量未找到: " + res.notFound.join(", ") + "，将使用字面值", "warn");
          }
          return res.resolved;
        }
        return texts;
      }).catch(function () {
        return texts;
      });
    }

    // 后端不可用：检查并提示
    var re = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
    var found = [];
    texts.forEach(function (t) {
      if (typeof t !== "string") return;
      var m;
      while ((m = re.exec(t)) !== null) found.push(m[1]);
    });
    if (found.length) {
      setMsg("配置中含 %" + found[0] + "% 引用，但后端未启动。请授权 backend.spawn 或在「设置 → 插件」中手动启动本插件的后台", "warn");
    }
    return Promise.resolve(texts);
  }

  // ===== GitHub API =====
  function ghFetch(url, method, token, headers, body) {
    var h = { "Authorization": "token " + token, "Accept": "application/vnd.github+json", "User-Agent": "gh-upload-plugin" };
    if (headers) { for (var k in headers) h[k] = headers[k]; }
    var opts = { method: method, headers: h };
    if (body) opts.body = body;
    return ms.net.fetch(url, opts).then(function (res) {
      // 契约：ms.net.fetch 返回 { status, ok, text, headers } 对象，不是字符串。
      // 当字符串用会导致 JSON.parse 失败、整个响应对象被当数据用（仓库列表恒为空、
      // 上传成功也取不到 content）。宿主 Tauri 路径对非 2xx 直接 reject
      // "HTTP <code>: <body>"；浏览器调试直连会把 4xx/5xx 也 resolve 进来，这里补齐。
      var isObj = res != null && typeof res === "object" && ("text" in res);
      var raw = isObj ? res.text : res;
      if (isObj && res.ok === false) {
        throw new Error("HTTP " + res.status + ": " + String(raw == null ? "" : raw).slice(0, 400));
      }
      if (typeof raw !== "string") return raw;
      try { return JSON.parse(raw); } catch (e) { return raw; }
    });
  }

  function fetchRepos(token) {
    return ghFetch("https://api.github.com/user/repos?per_page=100&page=1", "GET", token).then(function (data) {
      if (!Array.isArray(data)) return [];
      // 只列 Token 有推送权限的仓库（上传需要 push；按 has_issues 过滤与推送无关）
      return data.filter(function (r) { return !r.permissions || r.permissions.push; }).map(function (r) {
        return { fullName: r.full_name, defaultBranch: r.default_branch || "master",
          visibility: r.visibility, pushedAt: new Date(r.pushed_at).getTime() };
      }).sort(function (a, b) { return b.pushedAt - a.pushedAt; });
    });
  }

  function getFileSha(token, url) {
    return ghFetch(url, "GET", token).then(function (j) {
      return (j && j.sha) ? j.sha : null;
    }).catch(function () { return null; });
  }

  // ===== 上传 =====
  /** 归一化仓库配置：容忍完整 URL / .git 后缀 / 环境变量带进来的首尾空白与换行 */
  function normalizeRepo(s) {
    var v = String(s == null ? "" : s).trim();
    v = v.replace(/^[a-z]+:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "");
    v = v.replace(/\.git\/?$/, "").replace(/\/+$/, "");
    return v;
  }

  function doUpload(b64, fileName, cfg, commit, onStage) {
    var stage = onStage || function () {};
    var token = String(cfg.token == null ? "" : cfg.token).trim();
    var repo = normalizeRepo(cfg.repo);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error('仓库配置应为 owner/repo 格式（当前: "' +
        String(cfg.repo == null ? "" : cfg.repo).trim() + '"），可填 owner/repo 或完整 GitHub 仓库地址');
    }
    // 分支留空 = 不传 branch 参数，GitHub 用仓库默认分支（新仓库多为 main，
    // 硬编码 master 会对新建仓库报错）。sha 查询也必须带上同样的 ref，
    // 否则拿默认分支的 sha 去更新别的分支会 422。
    var branch = String(cfg.branch == null ? "" : cfg.branch).trim();
    var base = (cfg.path || "/uploads").replace(/\/+$/, "");
    var dns = cfg.dns || "https://cdn.jsdelivr.net/gh";

    var now = new Date();
    var y = now.getFullYear(), mo = String(now.getMonth()+1).padStart(2,"0"), d = String(now.getDate()).padStart(2,"0");
    var isImg = b64.indexOf("data:image") === 0;
    var finalName = fileName;
    if (isImg) {
      var dot = fileName.lastIndexOf(".");
      finalName = Date.now() + (dot>=0 ? fileName.substring(dot) : "");
    }
    var fullPath = base + "/" + y + "/" + mo + "/" + d + "/" + finalName;
    var comma = b64.indexOf(",");
    var fileData = comma >= 0 ? b64.substring(comma+1) : b64;
    var url = "https://api.github.com/repos/" + repo + "/contents" + fullPath;
    var shaUrl = url + (branch ? "?ref=" + encodeURIComponent(branch) : "");

    return getFileSha(token, shaUrl).then(function (sha) {
      // yyy 传入的文本优先作为 commit message（用户没给则退回默认文案）
      var message = String(commit == null ? "" : commit).trim() ||
        ("Upload " + finalName + " via plugin");
      var payload = { message: message, content: fileData };
      if (branch) payload.branch = branch;
      if (sha) payload.sha = sha;
      stage("upload");
      return ghFetch(url, "PUT", token, { "Content-Type": "application/json" }, JSON.stringify(payload))
        .catch(function (e) {
          // 带上仓库与建议：裸的 GitHub 404/403 JSON 对用户没有任何指向性
          var msg = String((e && e.message) || e);
          if (msg.indexOf("HTTP 404") === 0) {
            throw new Error('仓库 "' + repo + '" 不存在或 Token 无权访问（HTTP 404）：请核对 owner/repo 是否正确、仓库是否对 Token 可见（细粒度 Token 需勾选该仓库）。原始错误: ' + msg);
          }
          if (msg.indexOf("HTTP 403") === 0) {
            throw new Error('仓库 "' + repo + '" 拒绝写入（HTTP 403）：Token 缺少 Contents 写权限。原始错误: ' + msg);
          }
          throw e;
        });
    }).then(function (result) {
      if (!result || !result.content) throw new Error("上传响应异常");
      var initUrl = result.content.download_url;
      if (!initUrl) throw new Error("未获取到下载链接");
      // download_url = https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>；
      // 从尾部掐掉本次路径即得分支起点（分支留空时用的默认分支值未知，只能从返回里学）
      var dnsBase = dns.replace(/\/+$/, "");
      var marker = "/" + fullPath.replace(/^\//, "");
      var at = initUrl.indexOf(marker);
      var cdnUrl = initUrl;
      if (at >= 0) {
        var head = initUrl.slice(0, at);
        var branchStart = head.lastIndexOf("/") + 1;
        cdnUrl = dnsBase + "/" + repo + "@" + initUrl.substring(branchStart);
      }
      return { initUrl: initUrl, cdnUrl: cdnUrl, isImage: isImg };
    });
  }

  // ===== 图片压缩 =====
  function compressIfNeeded(file, b64) {
    if (!file.type.startsWith("image/") || !dom["gu-compression"].checked) return Promise.resolve(b64);
    var cfg = dom["gu-compression-config"].value || "0.9:600:0.9";
    var parts = cfg.split(":");
    var ratio = parseFloat(parts[0]) || 0.9;
    var minW = parseFloat(parts[1]) || 600;
    var quality = parseFloat(parts[2]) || 0.9;

    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        if (img.width * ratio < minW) { resolve(b64); return; }
        var cw = Math.round(img.width * ratio);
        var ch = Math.round(img.height * ratio);
        var c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);
        c.toBlob(function (blob) {
          if (!blob || blob.size >= file.size) { resolve(b64); return; }
          var f = new File([blob], file.name, { type: file.type });
          var r = new FileReader();
          r.onload = function () { resolve(r.result); };
          r.readAsDataURL(f);
        }, file.type, quality);
      };
      img.onerror = function () { resolve(b64); };
      img.src = b64;
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // ===== 图片预览（拖拽/粘贴/选择的图片先看后传） =====
  function showPreview(b64) {
    if (!dom["gu-preview"] || !dom["gu-drop-hint"]) return;
    dom["gu-preview"].src = b64;
    dom["gu-preview"].style.display = "block";
    dom["gu-drop-hint"].style.display = "none";
  }
  function clearPreview() {
    if (!dom["gu-preview"] || !dom["gu-drop-hint"]) return;
    dom["gu-preview"].removeAttribute("src");
    dom["gu-preview"].style.display = "none";
    dom["gu-drop-hint"].style.display = "";
  }

  // ===== 上传流程 =====
  /** 取走当前待用的 commit message（每个文件消费一次，空串则回退默认文案） */
  function takeCommitMessage() {
    var m = String(pendingCommit || "").trim();
    pendingCommit = "";
    return m;
  }

  /**
   * 处理并上传一个文件。
   * @returns {Promise} 完成（成功或失败）后 resolve——供「附加文件顺序上传」串联
   */
  function handleAndUpload(file) {
    if (!file) return Promise.resolve();
    if (isUploading) { setMsg("当前已有上传任务", "warn"); return Promise.resolve(); }
    isUploading = true;
    setResult("");
    clearPreview();
    dom["gu-drop-zone"].classList.add("gu-uploading");

    var b64, fileName = file.name;
    var commit = takeCommitMessage();
    var stages = uploadStages(file.type.indexOf("image/") === 0);
    beginProgress(stages);
    setProgress(stages[0]);

    return fileToBase64(file).then(function (data) {
      b64 = data;
      if (file.type.startsWith("image/")) showPreview(b64);
      // 第 1 阶段（读取）在这里才算真的读完：toFileBase64 的 FileReader 没有
      // 进度事件，所以「读完」是唯一可信的时间点。压缩阶段再往前推一次。
      setProgress(stages[1]);
      if (file.type.startsWith("image/") && dom["gu-compression"].checked) {
        return compressIfNeeded(file, b64);
      }
      return b64;
    }).then(function (finalB64) {
      b64 = finalB64;
      if (file.type.startsWith("image/")) showPreview(b64); // 压缩后用压缩图更新预览
      setProgress(stages[2]);
      // 收集并解析环境变量引用。
      // 仓库可能只存在存储里、而输入框还是空的（刚打开、用户没动过配置）：
      // DOM 取空时回退存储，别把「空仓库」发出去。
      var repoNow = dom["gu-repo-input"].value.trim();
      if (!repoNow && ms && ms.store) {
        repoNow = ms.store.get("repoInput", "") || ms.store.get("repoSelect", "") || "";
      }
      var raw = [
        dom["gu-token"].value.trim(),
        repoNow,
        dom["gu-branch"].value.trim(),
        dom["gu-path"].value.trim() || "/uploads",
        dom["gu-dns"].value.trim() || "https://cdn.jsdelivr.net/gh"
      ];
      return resolveRefs(raw).then(ensureResolved).then(function (resolved) {
        setProgress(stages[3]); // 查询远端 sha（doUpload 内部第一步）
        return doUpload(b64, fileName, {
          token: resolved[0], repo: resolved[1], branch: resolved[2],
          path: resolved[3], dns: resolved[4]
        }, commit, function (name) {
          if (name === "upload") setProgress(stages[4]);
        });
      });
    }).then(function (info) {
      showResult(info);
      endProgress(true, "上传完成");
      isUploading = false;
      dom["gu-drop-zone"].classList.remove("gu-uploading");
    }).catch(function (e) {
      // 失败：进度条标红停在当前阶段，并保留当前阶段的文案（用户能看出卡在哪）
      endProgress(false, "上传失败");
      setMsg("上传失败: " + (e.message || e), "err");
      setStatus("上传失败");
      isUploading = false;
      dom["gu-drop-zone"].classList.remove("gu-uploading");
    });
  }

  // ===== 搜索框附件（粘贴文件 → 过滤只剩本插件 → 打开即上传） =====
  /** data URL → File（宿主 ms.input.readFile 返回 data:...;base64,...） */
  function fileFromDataUrl(dataUrl, name) {
    try {
      var comma = String(dataUrl).indexOf(",");
      if (comma < 0) return null;
      var head = String(dataUrl).slice(0, comma);
      var mime = (/data:([^;]+)/.exec(head) || [])[1] || "";
      var bin = atob(String(dataUrl).slice(comma + 1));
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new File([u8], name, { type: mime });
    } catch (e) {
      return null;
    }
  }

  function attachmentKeyOf(a) {
    return String((a && a.path) || (a && a.name) || "").toLowerCase();
  }

  /**
   * 取「还没入队」的附加文件（kind === "file"），逐个读成 File。
   * file.read 权限缺失 / 宿主不支持时静默返回空数组——本视图仍可
   * 用自带的拖拽/粘贴/选择文件方式工作（能力降级，不打断）。
   */
  function loadAttachedFiles() {
    if (!ms.input || typeof ms.input.attachments !== "function") return Promise.resolve([]);
    var atts;
    try {
      atts = ms.input.attachments() || [];
    } catch (e) {
      return Promise.resolve([]);
    }
    var fresh = atts.filter(function (a) {
      return a && a.kind === "file" && attachmentKeyOf(a) && !attachmentSeen[attachmentKeyOf(a)];
    });
    // 先标记再读取：读取失败也视为「已处理」，避免每次打开都重试坏路径
    fresh.forEach(function (a) { attachmentSeen[attachmentKeyOf(a)] = true; });
    if (fresh.length === 0) return Promise.resolve([]);
    if (!ms.input.readFile) return Promise.resolve([]);
    return Promise.all(fresh.map(function (a) {
      return Promise.resolve(ms.input.readFile(a.path)).then(function (dataUrl) {
        return fileFromDataUrl(dataUrl, a.name);
      }).catch(function () {
        return null;
      });
    })).then(function (list) {
      return list.filter(Boolean);
    });
  }

  /** 有新附加文件就排队顺序上传（无则无事发生） */
  function ingestAttachments() {
    if (isUploading) return Promise.resolve(); // 正在传：不标记、下次再取
    return loadAttachedFiles().then(function (files) {
      if (!files.length) return;
      setMsg("检测到 " + files.length + " 个附加文件，开始上传", "ok");
      return files.reduce(function (p, f) {
        return p.then(function () { return handleAndUpload(f); });
      }, Promise.resolve());
    }).catch(function () { /* 附件能力不可用：保持原有交互 */ });
  }

  /**
   * 宿主直接投递过来的**真实路径**（"文件被拖进了本插件界面"）。
   *
   * 为什么需要这条通道：主窗口开着 Tauri 原生拖放处理器，HTML5 的
   * dragover/drop **永远不会触发**（事件在 WebView 层就被吃掉了），所以
   * 下面那段 HTML5 拖拽代码在主窗口里是收不到东西的。宿主是唯一拿得到
   * 落点坐标的一方：它判定「这次拖入落在本插件视图上」后，在会话载体上
   * 派发 ms-dropped-paths，把真实路径交过来。
   *
   * 相对「等宿主把文件塞进搜索框附件、再走 ingestAttachments」的好处：
   * 拖到插件界面的文件**不会**污染搜索框的附件 chip，语义也更准——文件
   * 是冲着这个上传界面来的。
   */
  function ingestDroppedPaths(paths) {
    if (!paths || !paths.length) return;
    if (!ms.input || typeof ms.input.readFile !== "function") {
      setMsg("缺少 file.read 权限，无法读取拖入的文件", "warn");
      return;
    }
    if (isUploading) { setMsg("当前已有上传任务", "warn"); return; }
    setMsg("检测到 " + paths.length + " 个拖入的文件，开始上传", "ok");
    var failures = [];
    var files = paths.map(function (p) {
      return Promise.resolve(ms.input.readFile(p)).then(function (dataUrl) {
        var name = String(p).split(/[\\/]/).pop() || "file";
        // 路径同样标记进 attachmentSeen：避免宿主/广播两条路把同一个文件传两遍
        attachmentSeen[String(p).toLowerCase()] = true;
        return fileFromDataUrl(dataUrl, name);
      }).catch(function (e) {
        // 以前这里静默返回 null：读取失败（最常见是宿主未把拖入路径登记给
        // Rust，读被拒「路径不在已附加的内容范围内」）时整批文件被悄悄过滤，
        // 用户只能看到「检测到 N 个…」然后什么都不发生。必须把原因说出来。
        failures.push({ path: p, error: String((e && e.message) || e) });
        return null;
      });
    });
    Promise.all(files).then(function (list) {
      var okFiles = list.filter(Boolean);
      if (failures.length) {
        var first = failures[0];
        setMsg(
          "有 " + failures.length + " 个文件读取失败（" + esc(first.path) + "：" + esc(first.error) + "）" +
          (okFiles.length ? "，其余 " + okFiles.length + " 个继续上传" : "，没有文件可上传"),
          "err"
        );
      }
      return okFiles.reduce(function (pr, f) {
        return pr.then(function () { return handleAndUpload(f); });
      }, Promise.resolve());
    });
  }

  // 宿主定向投递：文件被拖到本插件的界面上（主窗口原生拖放的唯一出口）
  document.addEventListener("ms-dropped-paths", function (e) {
    var detail = (e && e.detail) || {};
    ingestDroppedPaths(detail.paths);
  });

  // 附件集合变化（粘贴/拖入/移除文件）→ 立刻认领，不必等下次打开或子关键词。
  // 与 file-search 插件的做法一致；缺了这条，视图已经开着时新加的文件不会
  // 触发上传（旧行为只在初始化与收到子关键词时拉一次）。
  document.addEventListener("ms-attachments-changed", function () {
    void ingestAttachments();
  });

  // ===== 结果 =====
  function showResult(info) {
    var isImg = info.isImage;
    var md = "![" + (isImg ? "image" : "file") + "](" + info.cdnUrl + ")";
    var h = "";
    if (isImg) h += '<img src="' + esc(info.cdnUrl) + '" alt="upload" />';
    h += '<div class="gu-result-links">';
    var defaultCopy = isImg ? md : info.cdnUrl;
    h += '<a href="#" class="gu-copy-link" data-txt="' + esc(defaultCopy) + '">📋 复制' + (isImg ? " MD 链接" : "加速链接") + '</a>';
    h += '<a href="#" class="gu-copy-link" data-txt="' + esc(info.initUrl) + '">📋 复制原链</a>';
    h += '</div>';
    dom["gu-result"].innerHTML = h;
    setMsg("上传成功！", "ok");
    setStatus("上传成功");

    // 自动复制
    if (ms && ms.system && ms.system.writeClipboard) {
      ms.system.writeClipboard(defaultCopy).catch(function () {});
    } else {
      try { navigator.clipboard.writeText(defaultCopy); } catch (e) {}
    }

    dom["gu-result"].querySelectorAll(".gu-copy-link").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var txt = el.getAttribute("data-txt");
        if (ms && ms.system && ms.system.writeClipboard) {
          ms.system.writeClipboard(txt).catch(function () {});
        } else {
          try { navigator.clipboard.writeText(txt); } catch (e) {}
        }
        el.textContent = "✓ 已复制";
        setTimeout(function () { el.textContent = el.getAttribute("data-txt") === info.initUrl ? "📋 复制原链" : "📋 复制" + (isImg ? " MD 链接" : "加速链接"); }, 2000);
      });
    });
  }

  // ===== 配置存储 =====
  /** 自动保存的字段（面板收起 / 面板内「保存」都会写；可在初始化时开关） */
  var AUTO_SAVE_KEYS = ["token","branch","path","dns","compression","compression_config"];
  var autoSaveEnabled = false;

  /** 读仓库：优先当前输入框，其次存储（兼容旧版的 repoSelect 分栏字段） */
  function storedRepo() {
    if (!ms || !ms.store) return "";
    return String(ms.store.get("repoInput","") || ms.store.get("repoSelect","") || "");
  }

  function loadStore() {
    if (!ms || !ms.store) return Promise.resolve();
    // ms.store.get 同步返回（非 Promise）：直接取值写入各输入框
    dom["gu-token"].value = ms.store.get("token","") || "";
    // 仓库只剩一个输入框：旧版把「下拉选中的仓库」存在 repoSelect 里，
    // 迁移时两个键都读，老用户升级后不会看到配置变空。
    dom["gu-repo-input"].value = storedRepo();
    dom["gu-branch"].value = ms.store.get("branch","") || "";
    dom["gu-path"].value = ms.store.get("path","/uploads") || "/uploads";
    dom["gu-dns"].value = ms.store.get("dns","https://cdn.jsdelivr.net/gh") || "https://cdn.jsdelivr.net/gh";
    dom["gu-compression"].checked = ms.store.get("compression",0) === 1;
    dom["gu-compression-config"].value = ms.store.get("compression_config","0.9:600:0.9") || "0.9:600:0.9";
    return Promise.resolve();
  }

  /**
   * 保存配置。
   * @param {boolean} silent true = 自动保存（关面板时）：不弹「配置已保存」气泡，
   *   否则每次收起面板都刷一条提示，把上传结果/错误顶掉。
   */
  function saveStore(silent) {
    if (!ms || !ms.store) return Promise.resolve();
    if (!silent && !autoSaveEnabled) {
      // 用户主动点「保存」（面板内的按钮或顶部的保存态按钮）：给一次明确回执。
      // 自动保存（silent）不能走这里——每次收起面板都刷「配置已保存」会把
      // 上传结果/错误顶掉。
      setMsg("配置已保存", "ok");
    }
    var jobs = [
      ms.store.set("token", dom["gu-token"].value.trim()),
      ms.store.set("repoInput", dom["gu-repo-input"].value.trim()),
      ms.store.set("branch", dom["gu-branch"].value.trim()),
      ms.store.set("path", dom["gu-path"].value.trim()),
      ms.store.set("dns", dom["gu-dns"].value.trim()),
      ms.store.set("compression", dom["gu-compression"].checked ? 1 : 0),
      ms.store.set("compression_config", dom["gu-compression-config"].value),
    ];
    // 清掉旧版的分栏键，避免迁移后两处值长期不一致（读侧仍兼容）
    if (typeof ms.store.set === "function") jobs.push(ms.store.set("repoSelect", ""));
    return Promise.all(jobs);
  }

  // ===== 配置面板开合 =====
  var configVisible = false;

  /**
   * 展开/收起配置面板。
   * @param {boolean} next 目标状态（不传 = 取反，供顶部按钮切换用）
   * @param {{save?: boolean}} opts save=true 表示收起时顺带落盘
   *
   * 这是「点保存后自动收起」的唯一入口：按钮文字（配置/保存）与面板
   * display、configVisible 三者永远由这里一起改，不会再出现「按钮显示保存
   * 但面板其实是开着的」这种错位。
   */
  function setConfigVisible(next, opts) {
    var save = !!(opts && opts.save);
    configVisible = typeof next === "boolean" ? next : !configVisible;
    if (dom["gu-config-panel"]) dom["gu-config-panel"].style.display = configVisible ? "block" : "none";
    if (dom["gu-config-toggle"]) dom["gu-config-toggle"].textContent = configVisible ? "保存" : "配置";
    var btn = dom["gu-save-config"];
    if (btn) {
      btn.textContent = configVisible ? "保存并收起" : "保存";
      if (btn.setAttribute) btn.setAttribute("aria-expanded", configVisible ? "true" : "false");
    }
    if (!configVisible) closeRepoList();
    // 面板展开时聚焦 Token（用户打开配置多半是要改 Token / 仓库）
    if (configVisible && dom["gu-token"] && dom["gu-token"].focus) {
      try { dom["gu-token"].focus(); } catch (e) { /* 桩环境忽略 */ }
    }
    // 收起时落盘；saveStore 内部按 autoSaveEnabled 决定要不要弹提示
    if (!configVisible) return saveStore(!save);
    return Promise.resolve();
  }

  // ===== Token 校验 =====
  var validateSeq = 0;        // 自动校验可并发发起：过期响应不得覆盖新结果
  var lastValidatedToken = ""; // 最近一次发起校验的原文，避免同一 Token 重复请求

  /**
   * 校验 Token 并刷新仓库候选。
   *
   * @param {{quiet?: boolean}} opts quiet=true = 后台自动校验（打开视图、Token 变更），
   *   成功且确实拿到仓库时**不弹提示**。
   *
   * 为什么打开视图要安静：Token 存在存储里、每次都自动校验一遍，成功是稳态结果，
   * 而搜索框已经告诉用户「就绪」了——再往消息区压一条「Token 有效，共 55 个可推送仓库」
   * 只是噪音，还会把上传结果顶掉。**失败/异常仍然照报**（比如「没有可推送的仓库」
   * 是配置错误，用户必须看到），用户主动点「校验 Token」也一定有回执。
   */
  function doValidate(opts) {
    var quiet = !!(opts && opts.quiet);
    var raw = dom["gu-token"].value.trim();
    if (!raw) { setMsg("请填写 Token", "warn"); return; }
    lastValidatedToken = raw;
    var seq = ++validateSeq;

    dom["gu-validate-token"].disabled = true;
    dom["gu-validate-token"].textContent = "校验中...";

    resolveRefs([raw]).then(ensureResolved).then(function (r) {
      return fetchRepos(r[0]);
    }).then(function (repos) {
      if (seq !== validateSeq) return;
      reposCache = repos;
      // 仓库列表现在只是 combobox 的候选来源，不再是「要显示/隐藏的控件」：
      // 候选怎么变都不会动用户已填的值（旧版重建 <select> 会把选择重置成
      // 第一项，才需要在重建后一路回填，那套补偿逻辑整块删掉）。
      if (repoCombo.open) openRepoList();
      if (!repos.length) {
        setMsg("Token 有效，但没有可推送的仓库——请检查 Token 权限（细粒度 Token 需授予 Contents 写权限并勾选仓库）", "warn");
      } else if (!quiet) {
        setMsg("Token 有效，共 " + repos.length + " 个可推送仓库", "ok");
      }
    }).catch(function (e) {
      if (seq !== validateSeq) return;
      setMsg("校验失败: " + (e.message || e), "err");
    }).finally(function () {
      if (seq !== validateSeq) return;
      dom["gu-validate-token"].disabled = false;
      dom["gu-validate-token"].textContent = "校验 Token";
    });
  }

  // ===== 事件 =====
  (function bindEvents() {
    // Token 变更后自动校验：防抖 700ms，逐字输入/粘贴只在停顿后打一次 API；
    // 校验原文与上次相同（含刚初始化校验过的）不重复发起。
    var autoValidateTimer = null;
    function scheduleTokenValidate() {
      var raw = dom["gu-token"].value.trim();
      clearTimeout(autoValidateTimer);
      if (!raw) { lastValidatedToken = ""; return; }
      if (raw === lastValidatedToken) return;
      // quiet：Token 没变过、只是重新校验一遍拿候选，成功不必刷提示
      autoValidateTimer = setTimeout(function () { doValidate({ quiet: true }); }, 700);
    }
    dom["gu-token"].addEventListener("input", scheduleTokenValidate);

    // 配置面板切换：顶部按钮在「配置 ↔ 保存」之间切换；
    // 从「保存」态点下去 = 保存并收起（面板开合与落盘都在 setConfigVisible 里）
    dom["gu-config-toggle"].addEventListener("click", function () {
      if (configVisible) setConfigVisible(false, { save: true });
      else setConfigVisible(true);
    });

    // 验证 Token
    dom["gu-validate-token"].addEventListener("click", doValidate);

    // 仓库：可输入过滤的下拉（选择/手填同一个输入框，见 bindRepoCombo）
    bindRepoCombo();

    // 面板内「保存」= 保存并收起（用户点保存的意图就是「改完了，收工」，
    // 面板继续挡在上传区上面反而是多余的）
    dom["gu-save-config"].addEventListener("click", function () {
      setConfigVisible(false, { save: true });
    });

    // 其余字段失焦即保存（token 有自己的防抖校验，无需再存一次）
    var members = [dom["gu-repo-input"], dom["gu-branch"], dom["gu-path"], dom["gu-dns"], dom["gu-compression-config"]];
    members.forEach(function (el) {
      if (!el || !el.addEventListener) return;
      el.addEventListener("change", function () { void saveStore(true); });
      el.addEventListener("blur", function () { void saveStore(true); });
    });
    if (dom["gu-compression"] && dom["gu-compression"].addEventListener) {
      dom["gu-compression"].addEventListener("change", function () { void saveStore(true); });
    }

    // 上传区
    dom["gu-drop-zone"].addEventListener("click", function (e) {
      if (e.target === dom["gu-file-input"] || e.target.closest("a")) return;
      dom["gu-file-input"].click();
    });
    dom["gu-file-input"].addEventListener("click", function (e) { e.stopPropagation(); });
    dom["gu-file-input"].addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleAndUpload(f);
      this.value = "";
    });

    // 粘贴
    document.addEventListener("paste", function (e) {
      var items = (e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData) || {}).items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "file") { handleAndUpload(items[i].getAsFile()); break; }
      }
    });

    // 拖拽：挂在整个面板（.gu-container）上——上传区不再局限虚线框，
    // 文件拖到配置栏/消息区也能投；容器内 dragleave 靠 relatedTarget 判断
    // 是否真的离开了面板，避免经过子元素时高亮闪烁。
    // 注意：只在容器层挂一份（虚线框是它的子节点），防止 drop 冒泡重复触发。
    //
    // 重要：主窗口开着 Tauri 的**原生**拖放处理器，HTML5 的 dragover/drop
    // 在这里**永远不会触发**——所以主窗口下这条路是死的，文件走宿主的
    // ms-dropped-paths 投递（见上面的 ingestDroppedPaths）。
    // 保留这段是为了「配置窗口」（宿主显式禁用了原生处理器）以及将来可能
    // 出现的独立窗口形态，那里 HTML5 拖放是有效的。
    var container = document.querySelector(".gu-container");
    function inConfigPanel(t) {
      return !!(t && t.closest && t.closest(".gu-config-panel"));
    }
    if (container) {
      container.addEventListener("dragover", function (e) {
        if (inConfigPanel(e.target)) return;
        e.preventDefault();
        dom["gu-drop-zone"].classList.add("dragover");
      });
      container.addEventListener("dragleave", function (e) {
        if (container.contains(e.relatedTarget)) return;
        dom["gu-drop-zone"].classList.remove("dragover");
      });
      container.addEventListener("drop", function (e) {
        e.preventDefault();
        dom["gu-drop-zone"].classList.remove("dragover");
        if (inConfigPanel(e.target)) return;
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleAndUpload(f);
      });
      window.addEventListener("dragend", function () {
        dom["gu-drop-zone"].classList.remove("dragover");
      });
    }

    // 子关键词：搜索框「上传 : yyy」的 yyy —— 作为下次上传的 commit message；
    // 同时趁这次机会再取一遍搜索框附件（视图开着时用户新粘贴的文件走这条路径）。
    if (typeof onSubKeyword === "function") {
      onSubKeyword(function (msg) {
        pendingCommit = String(msg == null ? "" : msg);
        if (pendingCommit.trim()) {
          void ingestAttachments();
        }
        return true;
      });
    }
  })();

  // ===== 初始化 =====
  loadStore().then(function () {
    setStatus("正在初始化...");
    // 绑定所有变量按钮
    document.querySelectorAll(".gu-env-btn").forEach(function (btn) {
      var target = btn.getAttribute("data-target");
      if (target) bindEnvPicker(target, btn);
    });
    // 配置面板初始收起（按钮文案由 setConfigVisible 统一维护，别硬编码）
    setConfigVisible(false);
    // 面板收起 = 用户认为「配置改完了」→ 自动落盘。
    // 这解决一个真实痛点：用户改完 Token/路径直接点面板外继续上传，
    // 从不点「保存」，重开就发现改动没了。
    // 初始化完成后才打开开关，避免 loadStore 的赋值在自动保存监听之前被当成用户输入。
    autoSaveEnabled = true;
    // 尝试连接后端
    tryInitBackend().then(function () {
      // 打开视图时的校验只为把仓库候选拉起来，成功不该刷提示：
      // Token 一直存在存储里，这句话每次打开都出现就纯属噪音（用户明确反馈过）
      if (dom["gu-token"].value.trim()) doValidate({ quiet: true });
      setStatus("就绪，拖拽或粘贴文件上传");
      // 搜索框里已经附加的文件（用户「粘贴文件 → 回车」直达本视图）：自动排队上传
      void ingestAttachments();
    }).catch(function () {
      setStatus("就绪（后端未连接，环境变量引用不可用）");
      void ingestAttachments();
    });
  });

})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);