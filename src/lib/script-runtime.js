/**
 * 脚本应用（脚本项）运行时 —— 我的搜索桌面版
 *
 * 对应油猴版 v7.9.5 中「脚本项」相关的三块能力：
 * 1. registry.script（MSSE 会话：MS_SCRIPT_ENV_TEMPLATE / openSessionForMSSE / clearMSSE / tryRunTextViewHandler）
 * 2. showView 分支：执行 `-- script --` 段，由脚本自己调用 view.mount() 挂载 `-- view:html/css/js --`
 * 3. registry.view.textView：脚本视图的渲染与样式作用域限定（cssFillPrefix）
 *
 * 官方订阅里的脚本应用（「AI」「CKEditor-本地编辑器」「小象倒计时」等）依赖这套接口，
 * 缺失或行为不一致时会出现「脚本视图运行出错，已显示其 HTML 内容。」这类降级表现，
 * 因此这里按原版语义实现，并对每个接口做可测试的纯函数式封装。
 */

import { md2html, scopeCss } from "./util.js";

/** 脚本视图容器选择器（脚本样式只作用于该容器内部） */
export const SCRIPT_VIEW_PREFIX = "#text_show .script-view";

/* ============================================================
 * 1. MSSE 会话（MS_SCRIPT_ENV）
 * ============================================================ */

/**
 * 去掉数组重复项（还原 removeDuplicates）
 * @param {Array} objs
 * @param {string[]} props 参与比较的属性
 * @returns {Array}
 */
export function removeDuplicates(objs, props = ["title", "desc"]) {
  if (!Array.isArray(objs) || objs.length === 0) return [];
  const seen = new Set();
  const result = [];
  for (const item of objs) {
    const key = props.map((p) => String(item?.[p] ?? "\u0000")).join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 解析子搜索关键词（还原 registry.searchData.subSearch.getSubSearchKeyword）
 * @param {string} keyword 完整关键词，形如 `父关键词 : 子关键词`
 * @param {string} boundary 分隔符
 * @returns {string|undefined}
 */
export function getSubSearchKeyword(keyword, boundary) {
  const parts = String(keyword ?? "").split(boundary);
  if (parts.length < 2) return undefined;
  const sub = parts[1].trim();
  return sub === "" ? undefined : sub;
}

/**
 * 脚本视图上下文：封装「当前会话 + 视图容器」，
 * 以便把原版注册表里的脚本接口拆成可测试的纯逻辑。
 */
export class ScriptViewContext {
  /**
   * @param {object} opts
   * @param {() => Array} opts.getData 全部数据项
   * @param {(raw:string)=>Promise<Array>} [opts.matchSearch] 类 AI 匹配度搜索
   * @param {object} [opts.cache] 缓存接口
   * @param {(type,url,opts)=>Promise<string>} [opts.request] HTTP 请求（走 Rust 代理）
   * @param {()=>Promise<string>} [opts.getSelectedText] 让用户选择页面文本
   */
  constructor({
    getData = () => [],
    matchSearch = null,
    cache = null,
    request = null,
    getSelectedText = null,
  } = {}) {
    this.getData = getData;
    this.matchSearchImpl = matchSearch;
    this.cache = cache;
    this.requestImpl = request;
    this.getSelectedTextImpl = getSelectedText;
    /** 脚本页监听 IPush 事件（还原 MS_SCRIPT_ENV.event.sendListener） */
    this.sendListener = [];
    /** 视图是否已挂载（view.mount() 调用后为 true） */
    this.mounted = false;
  }

  /** 是否已开启会话（还原 SESSION_MS_SCRIPT_ENV !== undefined） */
  get opened() {
    return this._env != null;
  }

  /** 开启会话并返回脚本环境对象（还原 openSessionForMSSE） */
  openSession() {
    this._env = this.buildEnv();
    return this._env;
  }

  /** 结束会话：清空监听器（还原 clearMSSE + 退出视图后的清理） */
  clearMSSE() {
    this.sendListener.length = 0;
    this._env = null;
    this.mounted = false;
  }

  /**
   * 构建 MS_SCRIPT_ENV（还原 MS_SCRIPT_ENV_TEMPLATE）
   * 字段与官方脚本用的完全一致：cache / getSearchDB / getSelectedText / md2html /
   * request / matchSearch / data / event。
   */
  buildEnv() {
    return {
      event: { sendListener: this.sendListener },
      cache: this.cache,
      getSearchDB: () => [...this.getData()],
      getSelectedText: (msg) => (this.getSelectedTextImpl ? this.getSelectedTextImpl(msg) : undefined),
      md2html: (raw) => md2html(raw),
      request: (type, url, opts) =>
        this.requestImpl ? this.requestImpl(type, url, opts) : Promise.reject(new Error("request 不可用")),
      matchSearch: (kw) => (this.matchSearchImpl ? this.matchSearchImpl(kw) : Promise.resolve([])),
      data: {
        get: () => [...this.getData()],
        matchSearch: () => [],
        distinct: (items) => removeDuplicates(items),
      },
    };
  }

  /**
   * 把输入框里的「子搜索关键词」推送给脚本（还原 tryRunTextViewHandler）
   * @param {string} rawKeyword 输入框当前内容（原版为 input.val()）
   * @param {string} boundary 子搜索分隔符
   * @returns {{handled:boolean, parentKeyword:string, msg?:string}}
   */
  pushSubKeyword(rawKeyword, boundary) {
    // 仅在脚本视图展示中才处理（原版 seeNowMode() === SHOW_ITEM_DETAIL）
    if (!this.mounted) return { handled: false, parentKeyword: rawKeyword };
    const msg = getSubSearchKeyword(rawKeyword, boundary);
    if (msg == null) return { handled: false, parentKeyword: rawKeyword };
    if (this.sendListener.length === 0) return { handled: false, parentKeyword: rawKeyword };
    // 逐个通知（原版 sendListener.forEach）
    for (const listener of [...this.sendListener]) {
      try {
        listener(msg);
      } catch (e) {
        console.warn("[我的搜索] 脚本消息监听异常:", e);
      }
    }
    // 清掉子搜索部分，只留父关键词（原版 input.val(rawKeyword.replace(msg,""))）
    return { handled: true, parentKeyword: String(rawKeyword).split(boundary)[0], msg };
  }
}

/* ============================================================
 * 2. 脚本视图样式（cssFillPrefix）
 * ============================================================ */

/**
 * 把脚本项的 view:css 作用域限定到脚本视图容器（还原 registry.view.textView.cssFillPrefix）：
 * - `*` / `html` / `body` / `:root` 映射到容器自身，绝不污染应用界面
 * - 其余选择器统一加容器前缀
 * - @keyframes 等嵌套内容不加前缀（由 scopeCss 处理）
 * @param {string} css
 * @param {string} [prefix]
 */
export function scopeScriptCss(css, prefix = SCRIPT_VIEW_PREFIX) {
  return scopeCss(css, prefix);
}

/* ============================================================
 * 3. 执行脚本（script 段）与视图（view:* 段）
 * ============================================================ */

/**
 * 脚本视图对象（还原 showView 分支里的 view 对象）
 * @param {object} handlers
 * @param {Function} handlers.mount 真正的挂载实现（渲染 view:html/css/js）
 */
export function createScriptView(handlers = {}) {
  let beforeCallback = null;
  let afterCallback = null;
  return {
    /** 挂载前回调（还原 mountBefore） */
    mountBefore(handle) {
      if (typeof handle === "function") beforeCallback = handle;
      return this;
    },
    /** 挂载后回调（还原 mountAfter） */
    mountAfter(handle) {
      if (typeof handle === "function") afterCallback = handle;
      return this;
    },
    /** 挂载视图（还原 mount）：脚本项通过它触发 view:html/css/js 渲染 */
    mount() {
      if (beforeCallback != null) beforeCallback();
      if (typeof handlers.mount === "function") handlers.mount(afterCallback);
    },
  };
}

/**
 * 生成「外部打开」工具（还原 open(url).simulator(...)）：
 * 桌面版没有页面模拟器，simulator 退化为直接打开目标地址。
 * @param {(url:string)=>void} openExternal
 */
export function createScriptOpen(openExternal) {
  return function open(url) {
    const openUrl = url;
    return {
      simulator() {
        if (openUrl) openExternal(openUrl);
        return this;
      },
    };
  };
}

/**
 * 执行脚本项的 `-- script --` 段（还原 showView 分支）
 *
 * 原版是 `Function('obj', '(' + jscript + ')(obj)')({registry,cache,$,open,view})`：
 * 脚本函数自行决定是否调用 view.mount() 挂载视图，
 * 因此这里只负责构造 obj 并调用，返回值用于可测试性。
 *
 * @param {string} script `-- script --` 段源码
 * @param {object} obj 传给脚本函数的对象
 * @returns {{ok:boolean, error?:Error, result?:any, mounted:boolean}}
 */
export function runScriptFunction(script, obj, { view = null } = {}) {
  if (script == null || String(script).trim() === "") {
    return { ok: false, error: new Error("脚本为空"), mounted: false };
  }
  try {
    // 与原版一致：函数源码整体求值后立即调用
    const fn = new Function("obj", `(${script})(obj)`);
    const result = fn(obj);
    return { ok: true, result, mounted: view != null ? view.__mounted === true : false };
  } catch (error) {
    return { ok: false, error, mounted: false };
  }
}

/**
 * 执行脚本项的 `-- view:js --` 段。
 *
 * 原版把 js 与 html/css 拼成一段 HTML 后写入 textView（其中 `<script>(()=>{ js })()</script>`），
 * 即在浏览器里以 IIFE 执行；这里等价地用 new Function 包一层 IIFE，
 * 这样变量/函数不会泄漏到模块作用域，且同一脚本视图可重复执行。
 *
 * @param {string} viewJs `-- view:js --` 段源码
 * @param {object} obj 传给视图脚本的对象（cache/$/view/registry/open 等）
 * @returns {{ok:boolean, error?:Error}}
 */
export function runViewScript(viewJs, obj) {
  if (viewJs == null || String(viewJs).trim() === "") return { ok: true };
  try {
    const fn = new Function("obj", `(function(){\n${viewJs}\n})()`);
    fn(obj);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 判定脚本项是否需要挂载脚本视图（还原 showView 分支的判断）
 * @param {object} resourceObj
 */
export function hasScriptView(resourceObj) {
  if (resourceObj == null) return false;
  return Boolean(resourceObj["view:html"] || resourceObj["view:js"] || resourceObj["view:css"]);
}

/** 脚本视图运行异常时展示的提示文案（与油猴版行为一致） */
export const SCRIPT_VIEW_ERROR_TIP = "脚本视图运行出错，已显示其 HTML 内容。";
