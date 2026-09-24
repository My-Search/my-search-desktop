/** 插件市场 UI —— 纯功能、无第三方依赖 */

(function () {
  const $app = document.getElementById("app");
  const $list = document.getElementById("market-list");
  const $loading = document.getElementById("market-loading");
  const $error = document.getElementById("market-error");
  const $search = document.getElementById("market-search");
  const $pager = document.getElementById("market-pager");

  const PAGE_SIZE = 10; // 每页卡片数

  let view = null; // { entries, installedMap, updates, blocked }
  let query = ""; // 搜索关键字（作用于当前 tab）
  let page = 1; // 当前页码（1 起）
  let totalPages = 1;

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function showState(el, show) {
    $loading.style.display = "none";
    $error.style.display = "none";
    $list.style.display = "none";
    $pager.style.display = "none";
    if (el) el.style.display = show ? "block" : "none";
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
      // 最新：默认按「最近上架」排序（publishedAt 降序），
      // 同一时间/缺失时退回 updatedAt，再退回名称，保证顺序稳定可复现。
      return view.entries.slice().sort(compareByPublishedAt);
    }
    // 精选：已安装优先
    const featured = view.entries.filter((e) => view.installedMap[e.id]);
    const others = view.entries.filter((e) => !view.installedMap[e.id]);
    return [...featured, ...others];
  }

  /** 上架时间降序（缺失/非法时间排最后） */
  function compareByPublishedAt(a, b) {
    const ta = Date.parse(a.publishedAt || a.updatedAt || "") || 0;
    const tb = Date.parse(b.publishedAt || b.updatedAt || "") || 0;
    if (tb !== ta) return tb - ta;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-Hans-CN");
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
      const hasUpdate = view.updates.some((u) => u.id === e.id);
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
        actionHtml = '<button class="btn-market" data-action="update" data-id="' + escapeHtml(e.id) + '">更新 v' + escapeHtml(view.updates.find((u) => u.id === e.id).availableVersion) + "</button>";
      } else if (installed) {
        actionHtml = '<button class="btn-market btn-outline" data-action="uninstall" data-id="' + escapeHtml(e.id) + '">卸载</button>';
      } else {
        // 已废弃不禁止安装：用户可能仍在依赖它，或需要装上做数据迁移
        actionHtml = '<button class="btn-market" data-action="install" data-id="' + escapeHtml(e.id) + '">安装</button>';
      }

      html += '<article class="plugin-card' + (e.deprecated ? " plugin-card-deprecated" : "") + '">';
      html += '<div class="plugin-icon">' + (e.icon ? '<img src="' + escapeHtml(e.icon) + '" alt="">' : "🧩") + "</div>";
      html += '<div class="plugin-meta">';
      html += '<div class="plugin-name">' + escapeHtml(e.name) + badgeHtml + "</div>";
      if (e.description) html += '<p class="plugin-desc">' + escapeHtml(e.description) + "</p>";
      if (e.deprecated) {
        html += '<div class="plugin-deprecated-hint">⚠ ' + escapeHtml(e.deprecatedReason || "该插件已停止维护，可能不再可用") + "</div>";
      }
      html += '<div class="plugin-footer">';
      html += "<span>v" + escapeHtml(e.version) + "</span>";
      if (e.author) html += "<span>·</span><span>" + escapeHtml(e.author) + "</span>";
      if (e.downloads != null) html += "<span>·</span><span>" + e.downloads + " 次下载</span>";
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

  function renderPager(total) {
    totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (totalPages <= 1) {
      $pager.innerHTML = "";
      $pager.style.display = "none";
      return;
    }
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

  /** 统一渲染入口：tab 过滤 → 搜索过滤 → 分页切片 */
  function render() {
    if (!view) return;
    const entries = filterEntries(tabEntries(activeTab()));
    if (entries.length === 0) {
      page = 1;
      totalPages = 1;
      $list.innerHTML = '<div class="market-state">' + (query.trim() ? "没有找到匹配「" + escapeHtml(query.trim()) + "」的插件" : "暂无插件") + "</div>";
      showState($list, true);
      return;
    }
    totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const start = (page - 1) * PAGE_SIZE;
    renderCards(entries.slice(start, start + PAGE_SIZE));
    renderPager(entries.length);
  }

  async function loadMarket() {
    showState($loading, true);
    try {
      if (typeof ms === "undefined" || !ms.market) {
        showState($error, true);
        $error.textContent = "插件市场 API 不可用（缺少 plugin.install 权限）";
        return;
      }
      view = await ms.market.list();
      if (view.error) {
        showState($error, true);
        $error.textContent = "加载失败：" + escapeHtml(view.error);
        return;
      }
      // 安装/更新/卸载后重载也保留当前 tab 与搜索词
      render();
    } catch (e) {
      showState($error, true);
      $error.textContent = "加载失败：" + escapeHtml(String(e.message || e));
    }
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

    try {
      if (action === "install") {
        const result = await ms.market.install(id);
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      } else if (action === "update") {
        const result = await ms.market.update(id);
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      } else if (action === "uninstall") {
        const result = await ms.market.uninstall(id);
        if (!result.ok) throw new Error(result.error);
        await loadMarket();
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = originalText;
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

  loadMarket();

  // 重试：点击错误区域
  $error.addEventListener("click", function () {
    loadMarket();
  });
})();
