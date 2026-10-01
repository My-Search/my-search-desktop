/** 插件市场 UI —— 纯功能、无第三方依赖 */

(function () {
  const $app = document.getElementById("app");
  const $list = document.getElementById("market-list");
  const $loading = document.getElementById("market-loading");
  const $error = document.getElementById("market-error");
  const $search = document.getElementById("market-search");
  const $pager = document.getElementById("market-pager");
  const $latestSort = document.getElementById("market-latest-sort");

  const PAGE_SIZE = 10; // 每页卡片数

  let view = null; // { entries, installedMap, updates, blocked }
  let query = ""; // 搜索关键字（作用于当前 tab）
  let page = 1; // 当前页码（1 起）
  let totalPages = 1;
  // 「最新」tab 的排序口径：published = 最新上架（默认），updated = 最新更新。
  // 只影响「最新」tab，切到别的 tab 再切回来仍保留用户的选择。
  let latestSort = "published";

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /**
   * 官方地址链接的显示文案，按链接形态给用户一个更准确的提示：
   *   - GitHub 仓库里的**源码目录**（`github.com/<owner>/<repo>/tree/<ref>/...`）→「源码」；
   *   - GitHub 仓库根（`github.com/<owner>/<repo>`）→「仓库」；
   *   - 其余（作者主页、项目站点等）→「主页」。
   * 官方插件（源码在本仓库 plugins/<目录>）会命中第一档，显示为「源码」。
   */
  function linkLabel(url) {
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/(tree|blob)\//i.test(url)) return "源码";
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(url)) return "仓库";
    return "主页";
  }

  /** 外链图标（内联 SVG，随文字色 currentColor，不引外部资源） */
  const LINK_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 5h5v5"/><path d="M19 5l-7 7"/>' +
    '<path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5"/></svg>';

  /**
   * 切换四个状态区的显隐。
   *
   * 注意：**显示时清空 inline display，而不是写死 `block`**。
   * 这些元素各自的布局由样式表决定（如 `.market-loading` 是 flex 列），
   * 写死 inline `block` 会覆盖掉它，把 SVG 与文字挤成一行。
   * 隐藏用 inline `none`（要能压过样式表里任何 display 值）。
   */
  function showState(el, show) {
    $loading.style.display = "none";
    $error.style.display = "none";
    $list.style.display = "none";
    $pager.style.display = "none";
    if (el) el.style.display = show ? "" : "none";
  }

  function activeTab() {
    const t = document.querySelector(".tab.active");
    return t ? t.dataset.tab : "featured";
  }

  /** 当前 tab 的完整条目（未搜索、未分页） */
  function tabEntries(tab) {
    if (!view) return [];
    if (tab === "installed") {
      return view.entries.filter((e) => view.installedMap[e.id]);
    }
    if (tab === "latest") {
      // 最新：由二级排序决定口径——
      //   published：最近上架（publishedAt 降序，缺失退回 updatedAt）
      //   updated  ：最近更新（updatedAt 降序，缺失退回 publishedAt）
      // 同一时间/都缺失时退回名称，保证顺序稳定可复现。
      const key = latestSort === "updated" ? "updatedAt" : "publishedAt";
      const fallback = latestSort === "updated" ? "publishedAt" : "updatedAt";
      return view.entries.slice().sort((a, b) => compareByTime(a, b, key, fallback));
    }
    // 精选：已安装优先
    const featured = view.entries.filter((e) => view.installedMap[e.id]);
    const others = view.entries.filter((e) => !view.installedMap[e.id]);
    return [...featured, ...others];
  }

  /** 时间降序（主字段缺失/非法时退回 backup 字段，都缺则排最后，再按名称） */
  function compareByTime(a, b, key, backup) {
    const ta = Date.parse(a[key] || a[backup] || "") || 0;
    const tb = Date.parse(b[key] || b[backup] || "") || 0;
    if (tb !== ta) return tb - ta;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-Hans-CN");
  }

  /** 距今天数的粗粒度文案：今天 / 昨天 / N 天前 / YYYY-MM-DD（跨年或更久） */
  function formatSince(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 30) return days + " 天前";
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /** 关键字过滤：匹配名称/描述/ID/作者/标签/分类 */
  function filterEntries(entries) {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(function (e) {
      return [e.name, e.description, e.id, e.author]
        .concat(e.tags || [])
        .concat(e.categories || [])
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  function renderCards(entries) {
    let html = "";
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const installed = view.installedMap[e.id];
      const upd = view.updates.find((u) => u.id === e.id);
      const hasUpdate = !!upd;
      const isBlocked = view.blocked.includes(e.id);
      let actionHtml = "";
      let badgeHtml = "";

      if (e.official) badgeHtml += '<span class="badge badge-official">官方</span>';
      if (hasUpdate) badgeHtml += '<span class="badge badge-update">可更新</span>';
      if (e.deprecated) badgeHtml += '<span class="badge badge-deprecated">已废弃</span>';

      if (isBlocked) {
        actionHtml = '<button class="btn-market" disabled>已屏蔽</button>';
      } else if (hasUpdate) {
        // 有新版就只显示「更新」，不并排放卸载——一张卡片主推一个动作
        actionHtml = '<button class="btn-market" data-action="update" data-id="' + escapeHtml(e.id) + '">更新 v' + escapeHtml(upd.availableVersion) + "</button>";
      } else if (installed) {
        actionHtml = '<button class="btn-market btn-outline" data-action="uninstall" data-id="' + escapeHtml(e.id) + '">卸载</button>';
      } else {
        // 已废弃不禁止安装：用户可能仍在依赖它，或需要装上做数据迁移
        actionHtml = '<button class="btn-market" data-action="install" data-id="' + escapeHtml(e.id) + '">安装</button>';
      }

      html += '<article class="plugin-card' + (e.deprecated ? " plugin-card-deprecated" : "") + '">';
      // 图标：网络图（raw / github 直链）加载完成前显示骨架占位，
      // 加载失败退回 🧩 —— 三态由 .icon-loading / .icon-ready / .icon-failed 控制。
      // 用 <img class="icon-img"> 承载，事件在容器上委托（卡片是 innerHTML 重建的）。
      if (e.icon) {
        html += '<div class="plugin-icon icon-loading">';
        html += '<span class="icon-fallback" aria-hidden="true">🧩</span>';
        html += '<img class="icon-img" src="' + escapeHtml(e.icon) + '" alt="" loading="lazy" decoding="async">';
        html += "</div>";
      } else {
        html += '<div class="plugin-icon"><span class="icon-fallback" aria-hidden="true">🧩</span></div>';
      }
      html += '<div class="plugin-meta">';
      html += '<div class="plugin-name">' + escapeHtml(e.name) + badgeHtml + "</div>";
      if (e.description) html += '<p class="plugin-desc">' + escapeHtml(e.description) + "</p>";
      if (e.deprecated) {
        html += '<div class="plugin-deprecated-hint">⚠ ' + escapeHtml(e.deprecatedReason || "该插件已停止维护，可能不再可用") + "</div>";
      }
      // 更新日志：只在「本插件有新版本可更新」时展示**这一版**改了什么，
      // 平时卡片保持简洁。内容可多行（作者按行书写），靠 CSS 的 pre-line 保留换行。
      const changelog = (upd && upd.changelog) || "";
      if (hasUpdate && changelog) {
        html += '<div class="plugin-changelog">';
        html += '<div class="plugin-changelog-title">v' + escapeHtml(upd.availableVersion) + " 更新日志</div>";
        html += '<div class="plugin-changelog-body">' + escapeHtml(changelog) + "</div>";
        html += "</div>";
      }
      // 官方地址：优先宿主算好的 repoUrl（仓库优先，退回主页），老目录没有该字段时
      // 退回条目自带的 repository / homepage。放说明下方，每个插件都能点开官方地址。
      const linkUrl = e.repoUrl || e.repository || e.homepage;
      if (linkUrl) {
        html += '<a class="plugin-link" data-link="' + escapeHtml(linkUrl) + '" href="' + escapeHtml(linkUrl) + '" target="_blank" rel="noopener noreferrer" title="在浏览器中打开：' + escapeHtml(linkUrl) + '">';
        html += LINK_ICON + "<span>" + escapeHtml(linkLabel(linkUrl)) + "</span>";
        html += "</a>";
      }
      html += '<div class="plugin-footer">';
      html += "<span>v" + escapeHtml(e.version) + "</span>";
      if (e.author) html += "<span>·</span><span>" + escapeHtml(e.author) + "</span>";
      if (e.downloads != null) html += "<span>·</span><span>" + e.downloads + " 次下载</span>";
      // 只在「最新」tab 标出排序依据的时间，让「为什么排在这」可见；
      // 其它 tab 的排序口径不同，显示这个时间会误导。
      if (activeTab() === "latest") {
        const iso = latestSort === "updated" ? e.updatedAt : e.publishedAt;
        const since = formatSince(iso);
        if (since) {
          html += "<span>·</span><span>" + (latestSort === "updated" ? "更新于 " : "上架于 ") + escapeHtml(since) + "</span>";
        }
      }
      html += "</div></div>";
      html += '<div class="plugin-action">' + actionHtml + "</div>";
      html += "</article>";
    }
    $list.innerHTML = html;
    showState($list, true); // 顺带隐藏分页条，由 renderPager 决定是否重新显示
  }

  /** 页码按钮：≤7 页全显，否则只显首尾与当前页附近（… 省略） */
  function pageItems(current, pages) {
    if (pages <= 7) {
      return Array.from({ length: pages }, function (_, i) {
        return i + 1;
      });
    }
    const items = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(pages - 1, current + 1);
    if (start > 2) items.push("…");
    for (let i = start; i <= end; i++) items.push(i);
    if (end < pages - 1) items.push("…");
    items.push(pages);
    return items;
  }

  /**
   * 渲染分页条。**始终显示**，即使总数不足一页（totalPages === 1）：
   * 位置稳定，不因插件多少而在「有/无分页条」之间跳动；
   * 单页时只有第 1 页可点，上/下一页均为禁用态。
   */
  function renderPager(total) {
    totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let html = '<span class="pager-info">共 ' + total + " 个 · 第 " + page + "/" + totalPages + " 页</span>";
    html += '<button class="pager-btn" data-page="prev"' + (page <= 1 ? " disabled" : "") + ">上一页</button>";
    pageItems(page, totalPages).forEach(function (it) {
      if (it === "…") {
        html += '<span class="pager-ellipsis">…</span>';
      } else {
        html += '<button class="pager-btn' + (it === page ? " active" : "") + '" data-page="' + it + '">' + it + "</button>";
      }
    });
    html += '<button class="pager-btn" data-page="next"' + (page >= totalPages ? " disabled" : "") + ">下一页</button>";
    $pager.innerHTML = html;
    $pager.style.display = "flex";
  }

  /**
   * 同步「最新」二级排序控件的显隐与选中态。
   * 只在「最新」tab 出现——其它 tab 的排序口径由 tabEntries 固定，控件露出来会误导。
   */
  function syncLatestSortUI() {
    if (!$latestSort) return;
    const on = activeTab() === "latest";
    $latestSort.style.display = on ? "" : "none";
    if (!on) return;
    $latestSort.querySelectorAll(".sort-opt").forEach(function (btn) {
      const active = btn.dataset.sort === latestSort;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  /** 统一渲染入口：tab 过滤 → 搜索过滤 → 分页切片 */
  function render() {
    if (!view) return;
    syncLatestSortUI();
    const entries = filterEntries(tabEntries(activeTab()));
    if (entries.length === 0) {
      page = 1;
      totalPages = 1;
      $list.innerHTML = '<div class="market-state">' + (query.trim() ? "没有找到匹配「" + escapeHtml(query.trim()) + "」的插件" : "暂无插件") + "</div>";
      showState($list, true);
      // 空结果也照常显示分页条（共 0 个 · 第 1/1 页），
      // 避免列表区与分页条在「空/非空」之间布局跳动。
      renderPager(0);
      return;
    }
    totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const start = (page - 1) * PAGE_SIZE;
    renderCards(entries.slice(start, start + PAGE_SIZE));
    renderPager(entries.length);
  }

  /** 静默重试次数：首次失败后再试 2 次，都失败才把错误摆到界面上 */
  const LOAD_RETRIES = 2;
  /** 重试间隔基数（毫秒），按次数线性退避：600ms、1200ms */
  const RETRY_DELAY_MS = 600;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 拉一次目录并做基本校验。**不碰 DOM**，便于重试循环复用。
   * 成功返回 { ok: true, view }；失败返回 { ok: false, fatal, message }。
   * `fatal: true` 表示重试也不会好（如缺权限），调用方应立即报错。
   */
  async function fetchMarketOnce() {
    if (typeof ms === "undefined" || !ms.market) {
      return { ok: false, fatal: true, message: "插件市场 API 不可用（缺少 plugin.install 权限）" };
    }
    const v = await ms.market.list();
    if (v && v.error) return { ok: false, message: String(v.error) };
    return { ok: true, view: v };
  }

  /**
   * 加载目录：失败静默重试 LOAD_RETRIES 次。
   * 只有「非致命且重试耗尽」才显示错误 —— 显示成「网络异常」+ 重试按钮。
   */
  async function loadMarket() {
    showState($loading, true);
    let lastMessage = "";
    for (let attempt = 0; attempt <= LOAD_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
      try {
        const r = await fetchMarketOnce();
        if (r.ok) {
          view = r.view;
          render(); // 安装/更新/卸载后重载也保留当前 tab 与搜索词
          return;
        }
        lastMessage = r.message;
        if (r.fatal) break; // 重试无意义，直接报错
      } catch (e) {
        lastMessage = String((e && e.message) || e);
      }
    }
    showError(lastMessage);
  }

  /** 展示错误态。对外文案统一为「网络异常」，具体原因放 title 便于排查 */
  function showError(detail) {
    const $text = $error.querySelector(".error-text");
    if ($text) $text.textContent = "网络异常";
    $error.title = detail ? "原因：" + detail : "";
    showState($error, true);
  }

  $app.addEventListener("click", async function (ev) {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const originalText = btn.textContent;
    btn.disabled = true;
    // 安装/更新/卸载都可能耗时较长，先切换文案给出进行中的反馈
    if (action === "install") btn.textContent = "安装中…";
    else if (action === "update") btn.textContent = "更新中…";
    else if (action === "uninstall") btn.textContent = "卸载中…";

    // 成功或用户取消都会走 loadMarket 重渲染卡片（按钮随之重建）；
    // 取消走 restoreBtn 静默复位，不留「安装中…」的僵死态。
    const restoreBtn = () => {
      btn.disabled = false;
      btn.textContent = originalText;
    };

    try {
      if (action === "install") {
        const result = await ms.market.install(id);
        // 用户在安装确认弹窗里点了「取消」：不是失败，静默恢复按钮
        if (result.cancelled) return restoreBtn();
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      } else if (action === "update") {
        const result = await ms.market.update(id);
        if (result.cancelled) return restoreBtn();
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      } else if (action === "uninstall") {
        const result = await ms.market.uninstall(id);
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      }
    } catch (e) {
      restoreBtn();
      const msg = "操作失败: " + String(e.message || e);
      // ms.ui.toast 需要 ui.notify 权限；未授予（或被用户撤销）时退回内联错误提示，
      // 避免错误处理器自身再抛一个未捕获的 PluginPermissionError
      const canNotify =
        typeof ms !== "undefined" &&
        ms.ui &&
        (!ms.plugin || !ms.plugin.has || ms.plugin.has("ui.notify"));
      if (canNotify) {
        ms.ui.toast(msg, "error");
      } else {
        $error.textContent = msg;
        showState($error, true);
      }
    }
  });

  // Tab切换（切换后回到第 1 页，保留搜索词）
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
      });
      page = 1;
      render();
    });
  });

  // 搜索：输入即过滤，回到第 1 页
  $search.addEventListener("input", function () {
    query = $search.value;
    page = 1;
    render();
  });

  // 「最新」二级排序：切换口径后回到第 1 页（选中态由 syncLatestSortUI 统一刷新）
  if ($latestSort) {
    $latestSort.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-sort]");
      if (!btn) return;
      const next = btn.dataset.sort;
      if (next !== "published" && next !== "updated") return;
      if (next === latestSort) return; // 已选中，避免无谓重排
      latestSort = next;
      page = 1;
      render();
    });
  }

  // 分页条点击：上一页/下一页/指定页
  $pager.addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    const v = btn.dataset.page;
    if (v === "prev") page = Math.max(1, page - 1);
    else if (v === "next") page = Math.min(totalPages, page + 1);
    else {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) page = n;
    }
    render();
  });

  // 启动：主搜索框「插件市场 : 关键字」转发的子关键字 → 同步到搜索框过滤
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (msg) {
      query = String(msg == null ? "" : msg);
      $search.value = query;
      page = 1;
      render();
    });
  }

  // 图标加载结果 → 切三态。委托到列表容器上（卡片经 innerHTML 反复重建，
  // 逐个绑监听会随重建丢失）。
  // 用**捕获阶段**：load / error 不冒泡，捕获阶段才能在容器上收到。
  // 实测 load 事件对网络图、缓存图、data: URI 都是异步投递的，因此
  // 「innerHTML 赋值时图片已 complete、事件不再补发」不会发生，无需额外兜底扫描。
  $list.addEventListener(
    "load",
    function (ev) {
      const img = ev.target;
      if (!img.classList || !img.classList.contains("icon-img")) return;
      const box = img.closest(".plugin-icon");
      if (box) box.classList.replace("icon-loading", "icon-ready");
    },
    true
  );
  $list.addEventListener(
    "error",
    function (ev) {
      const img = ev.target;
      if (!img.classList || !img.classList.contains("icon-img")) return;
      const box = img.closest(".plugin-icon");
      if (box) box.classList.replace("icon-loading", "icon-failed");
    },
    true
  );

  /**
   * 用系统浏览器打开一个外链。
   *
   * 优先走宿主 API（ms.system.openExternal，需 system.openExternal 权限）；
   * 未授权时返回 false，让调用方退回锚点自身的 target=_blank 行为
   * （hero 仓库入口与卡片上的官方地址链接共用这一段逻辑）。
   */
  async function openExternalUrl(url) {
    const canOpen = typeof ms !== "undefined" && ms.system && ms.system.openExternal;
    if (!canOpen) return false;
    try {
      await ms.system.openExternal(url);
    } catch (e) {
      const msg = "打开链接失败: " + String((e && e.message) || e);
      const canNotify =
        typeof ms !== "undefined" &&
        ms.ui &&
        (!ms.plugin || !ms.plugin.has || ms.plugin.has("ui.notify"));
      if (canNotify) ms.ui.toast(msg, "error");
      else window.open(url, "_blank", "noopener");
    }
    return true;
  }

  // 仓库入口：点 GitHub 图标 → 系统浏览器打开市场仓库。
  // 优先走宿主 API；未授权时退回锚点自身的 target=_blank 行为，保证始终能打开。
  const $repo = document.getElementById("market-repo-link");
  if ($repo) {
    $repo.addEventListener("click", async function (ev) {
      const url = $repo.getAttribute("href");
      if (await openExternalUrl(url)) ev.preventDefault();
    });
  }

  // 卡片上的「官方地址」链接：同样委托到列表容器（卡片 innerHTML 反复重建）。
  // 由 openExternalUrl 决定是否 preventDefault（宿主不可用时交给原生跳转）。
  $list.addEventListener("click", async function (ev) {
    const link = ev.target.closest && ev.target.closest("[data-link]");
    if (!link) return;
    const url = link.getAttribute("data-link");
    if (await openExternalUrl(url)) ev.preventDefault();
  });

  loadMarket();

  // 重试：点击「重新加载」按钮（只在静默重试耗尽后才会看到它）
  const $retry = document.getElementById("market-retry");
  if ($retry) {
    $retry.addEventListener("click", function (ev) {
      // 阻止冒泡，避免将来误触发区域级点击处理
      ev.stopPropagation();
      $retry.disabled = true;
      loadMarket().finally(function () {
        $retry.disabled = false;
      });
    });
  }
})();
