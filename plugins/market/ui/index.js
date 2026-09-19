/** 插件市场 UI —— 纯功能、无第三方依赖 */

(function () {
  const $app = document.getElementById("app");
  const $list = document.getElementById("market-list");
  const $loading = document.getElementById("market-loading");
  const $error = document.getElementById("market-error");

  let view = null; // { entries, installedMap, updates, blocked }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function showState(el, show) {
    $loading.style.display = "none";
    $error.style.display = "none";
    $list.style.display = "none";
    if (el) el.style.display = show ? "block" : "none";
  }

  function renderCards(entries, activeTab) {
    if (!entries || entries.length === 0) {
      $list.innerHTML = '<div class="market-state">暂无插件</div>';
      showState($list, true);
      return;
    }

    let html = "";
    const limit = activeTab === "updates" ? entries.length : entries.length;
    for (let i = 0; i < limit; i++) {
      const e = entries[i];
      const installed = view.installedMap[e.id];
      const hasUpdate = view.updates.some((u) => u.id === e.id);
      const isBlocked = view.blocked.includes(e.id);
      let actionHtml = "";
      let badgeHtml = "";

      if (e.official) badgeHtml += '<span class="badge badge-official">官方</span>';
      if (hasUpdate) badgeHtml += '<span class="badge badge-update">可更新</span>';

      if (isBlocked) {
        actionHtml = '<button class="btn-market" disabled>已屏蔽</button>';
      } else if (hasUpdate) {
        actionHtml = '<button class="btn-market" data-action="update" data-id="' + escapeHtml(e.id) + '">更新 v' + escapeHtml(view.updates.find((u) => u.id === e.id).availableVersion) + "</button>";
      } else if (installed) {
        actionHtml = '<button class="btn-market btn-outline" data-action="uninstall" data-id="' + escapeHtml(e.id) + '">卸载</button><span class="plugin-footer" style="margin-top:0;margin-left:8px">v' + escapeHtml(installed) + "</span>";
      } else {
        actionHtml = '<button class="btn-market" data-action="install" data-id="' + escapeHtml(e.id) + '">安装</button>';
      }

      html += '<div class="plugin-card">';
      html += '<div class="plugin-icon">' + (e.icon ? '<img src="' + escapeHtml(e.icon) + '" style="width:24px;height:24px">' : "🧩") + "</div>";
      html += '<div class="plugin-meta">';
      html += '<div class="plugin-name">' + escapeHtml(e.name) + badgeHtml + "</div>";
      if (e.description) html += '<div class="plugin-desc">' + escapeHtml(e.description) + "</div>";
      html += '<div class="plugin-footer">';
      html += "v" + escapeHtml(e.version);
      if (e.author) html += " · " + escapeHtml(e.author);
      if (e.downloads != null) html += " · " + e.downloads + " 次下载";
      html += "</div></div>";
      html += '<div class="plugin-action">' + actionHtml + "</div>";
      html += "</div>";
    }
    $list.innerHTML = html;
    showState($list, true);
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
      // 已安装优先 + 精选排序
      const featured = view.entries.filter((e) => view.installedMap[e.id]);
      const others = view.entries.filter((e) => !view.installedMap[e.id]);
      const sorted = [...featured, ...others];
      renderCards(sorted, "featured");
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
    btn.disabled = true;

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
      if (typeof ms !== "undefined" && ms.ui) ms.ui.toast("操作失败: " + String(e.message || e), "error");
    }
  });

  // Tab切换
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const tabName = tab.dataset.tab;
      if (!view) return;
      let entries;
      if (tabName === "featured") {
        const featured = view.entries.filter((e) => view.installedMap[e.id]);
        const others = view.entries.filter((e) => !view.installedMap[e.id]);
        entries = [...featured, ...others];
      } else if (tabName === "installed") {
        entries = view.entries.filter((e) => view.installedMap[e.id]);
      } else if (tabName === "updates") {
        entries = view.updates.map((u) => view.entries.find((e) => e.id === u.id)).filter(Boolean);
      }
      if (entries) renderCards(entries, tabName);
    });
  });

  // 启动
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (msg) {
      // 插件市场: 关键字 → 可用作搜索过滤
    });
  }

  loadMarket();

  // 重试：点击错误区域
  $error.addEventListener("click", function () {
    loadMarket();
  });
})();