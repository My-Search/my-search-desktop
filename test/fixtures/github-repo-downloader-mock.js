/**
 * GitHub 仓库搜索与批量下载器 —— 浏览器 UI 测试桩（非交付物）
 *
 * 在真实 Chrome 里替代宿主注入的 ms / env / plugin / host / ...
 * 后端用固定数据模拟，重点验证前端事件、渲染与 RPC 参数。
 */
/* global window, document */
(function () {
  "use strict";

  var now = Math.floor(Date.now() / 1000);
  var C = {
    hasToken: false,
    tokenHint: "",
    login: "",
    apiBase: "https://api.github.com",
    proxy: "",
    version: "1.0.0",
    platform: "win32",
    rateLimit: {
      search: { limit: 10, remaining: 9, reset: now + 60, used: 1 },
      core: { limit: 60, remaining: 58, reset: now + 3600, used: 2 }
    }
  };

  var mock = {
    config: C,
    searchCalls: [],
    startCalls: [],
    openFolderCalls: [],
    openExternalCalls: [],
    toasts: [],
    pickFolderCalls: [],
    notifications: {},
    started: false,
    jobCalls: 0,
    jobPath: "C:\\Users\\Test\\Downloads",
    jobId: "job-mock-1"
  };

  function repo(owner, name, extra) {
    var full = owner + "/" + name;
    var base = {
      fullName: full,
      owner: owner,
      repo: name,
      private: false,
      fork: false,
      archived: false,
      isTemplate: false,
      description: "演示仓库",
      language: "JavaScript",
      stars: 1000,
      forks: 100,
      license: "MIT",
      updatedAt: "2026-11-20T08:30:00Z",
      pushedAt: "2026-11-20T08:30:00Z",
      createdAt: "2011-01-01T00:00:00Z",
      defaultBranch: "main",
      htmlUrl: "https://github.com/" + full,
      size: 120,
      homepage: "",
      ownerType: "User",
      topics: ["demo", "sample"]
    };
    Object.keys(extra || {}).forEach(function (key) {
      base[key] = extra[key];
    });
    return base;
  }

  var ITEMS = [
    repo("octocat", "Hello-World", {
      description: "My first repository on GitHub!",
      language: "",
      stars: 1234,
      forks: 56,
      license: "MIT",
      defaultBranch: "master",
      size: 120,
      topics: ["demo", "hello", "octocat"]
    }),
    repo("octocat", "Spoon-Knife", {
      description: "This repo is for demonstration purposes only.",
      language: "HTML",
      stars: 100,
      forks: 200,
      license: "",
      defaultBranch: "main",
      size: 320,
      topics: ["octocat", "demo"]
    }),
    repo("facebook", "react", {
      description: "The library for web and native user interfaces.",
      language: "JavaScript",
      stars: 230000,
      forks: 45000,
      license: "MIT",
      size: 200000,
      topics: ["react", "frontend", "javascript", "ui"]
    })
  ];

  function snapshot(status) {
    var running = status === "running";
    var percent = running ? 45 : 100;
    var bytes = running ? 920 : 2048;
    return {
      jobId: mock.jobId,
      status: status,
      phase: "download",
      canceled: false,
      error: "",
      destDir: mock.jobPath,
      destRoot: mock.jobPath,
      outputPath: "",
      mergeFallback: false,
      mergeFallbackReason: "",
      createdAt: Date.now() - 4000,
      finishedAt: running ? 0 : Date.now(),
      elapsedSec: running ? 3 : 6,
      overall: {
        percent: percent,
        doneBytes: bytes,
        totalBytes: 2048,
        speed: running ? 520 : 0,
        etaSec: running ? 3 : 0,
        reposDone: running ? 0 : 1,
        reposTotal: 1,
        failed: 0
      },
      items: [
        {
          index: 0,
          fullName: "octocat/Hello-World",
          status: running ? "running" : "done",
          bytes: bytes,
          totalBytes: 2048,
          error: "",
          finalPath: running ? "" : mock.jobPath + "\\octocat--Hello-World.zip",
          separated: false,
          separatedReason: ""
        }
      ],
      options: {
        format: "zip",
        merge: true,
        template: "{owner}--{repo}",
        bundleName: "github-repos-test",
        subfolder: false,
        subfolderName: "",
        concurrency: 3
      }
    };
  }

  function call(method, params) {
    params = params || {};
    if (method === "getConfig") return Promise.resolve(mock.config);
    if (method === "setConfig") {
      if (params.clearToken) {
        mock.config.hasToken = false;
        mock.config.tokenHint = "";
        mock.config.login = "";
      }
      if (typeof params.token === "string" && params.token.trim()) {
        mock.config.hasToken = true;
        mock.config.tokenHint = "…" + params.token.trim().slice(-4);
        mock.config.login = "";
      }
      if (typeof params.apiBase === "string") mock.config.apiBase = params.apiBase;
      if (typeof params.proxy === "string") mock.config.proxy = params.proxy;
      return Promise.resolve(mock.config);
    }
    if (method === "testToken") {
      var login = "mockuser";
      return Promise.resolve({
        ok: true,
        login: login,
        name: "Mock User",
        rateLimit: {
          search: { limit: 30, remaining: 29, reset: now + 60, used: 1 },
          core: { limit: 5000, remaining: 4998, reset: now + 3600, used: 2 }
        }
      });
    }
    if (method === "search") {
      mock.searchCalls.push(params);
      if (String(params.q || "").indexOf("bulk") >= 0) {
        var bulk = [];
        for (var i = 0; i < 40; i++) {
          bulk.push(
            repo("bulk", "repo-" + i, {
              description: "用于验证长列表滚动的仓库 #" + i,
              stars: 900 - i,
              forks: 90 - i,
              size: 80 + i,
              topics: ["bulk", "scroll"]
            })
          );
        }
        return Promise.resolve({
          items: bulk,
          totalCount: 40,
          incomplete: false,
          page: 1,
          perPage: 30,
          hasMore: false,
          rate: { limit: 10, remaining: 6, reset: now + 60, used: 4 },
          cached: false,
          query: params.q
        });
      }
      var page = Number(params.page) || 1;
      var pageItems = page <= 1 ? ITEMS.slice(0, 2) : ITEMS.slice(2);
      return Promise.resolve({
        items: pageItems,
        totalCount: 6,
        incomplete: false,
        page: page,
        perPage: Number(params.perPage) || 30,
        hasMore: page < 2,
        rate: { limit: 10, remaining: page < 2 ? 8 : 7, reset: now + 60, used: 2 },
        cached: false,
        query: params.q
      });
    }
    if (method === "downloadStart") {
      mock.startCalls.push(params);
      mock.started = true;
      mock.jobCalls = 0;
      mock.jobPath = params.destDir;
      return Promise.resolve({
        jobId: mock.jobId,
        count: (params.items || []).length,
        destDir: params.destDir,
        format: (params.options && params.options.format) || "zip",
        merge: !!(params.options && params.options.merge)
      });
    }
    if (method === "getJob") {
      if (!mock.started) return Promise.resolve(null);
      mock.jobCalls++;
      return Promise.resolve(snapshot(mock.jobCalls < 2 ? "running" : "done"));
    }
    if (method === "cancelDownload") return Promise.resolve({ canceled: true });
    if (method === "openFolder") {
      mock.openFolderCalls.push(params);
      return Promise.resolve(true);
    }
    return Promise.reject(new Error("未模拟的后端方法：" + method));
  }

  window.__mock = mock;

  window.ms = {
    store: {
      get: function (key, fallback) {
        try {
          var raw = window.localStorage.getItem("ui-test:" + key);
          return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
          return fallback;
        }
      },
      set: function (key, value) {
        try {
          window.localStorage.setItem("ui-test:" + key, JSON.stringify(value));
        } catch (e) {
          /* ignore */
        }
        return true;
      }
    },
    backend: {
      call: call,
      onNotification: function (name, handler) {
        mock.notifications[name] = handler;
        return function () {
          if (mock.notifications[name] === handler) delete mock.notifications[name];
        };
      }
    },
    ui: {
      toast: function (text, type) {
        mock.toasts.push({ text: String(text), type: type || "ok" });
      },
      confirm: function () {
        return Promise.resolve(true);
      },
      pickFolder: function (opts) {
        mock.pickFolderCalls.push(opts || {});
        return Promise.resolve(mock.jobPath);
      },
      setHeight: function () {
        return true;
      }
    },
    system: {
      openExternal: function (url) {
        mock.openExternalCalls.push(String(url));
        return Promise.resolve(true);
      }
    },
    log: function (level, message) {
      if (window.__uiLogs) window.__uiLogs.push([level, message]);
    }
  };

  window.env = {};
  window.plugin = { id: "com.zhuangjie.github-repo-downloader", version: "1.0.0" };
  window.host = {};
  window.keyword = "仓库";
  window.inputValue = "";
  window.md2html = function (s) {
    return String(s == null ? "" : s);
  };
  window.onSubKeyword = function (fn) {
    window.__subKeyword = fn;
  };
  window.openExternal = function (url) {
    mock.openExternalCalls.push(String(url));
    return Promise.resolve(true);
  };
})();
