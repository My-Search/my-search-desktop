/**
 * 脚本项宿主（MSSE 会话 + 视图挂载）
 *
 * 对应原 main.js 中：
 * - createScriptEnv / clearScriptSession / tryRunScriptTextViewHandler
 * - mountScriptView / waitViewRenderingComplete / makeLocalQuery / buildMiniRegistry
 * - handleScriptItem / runScriptItem / matchSearchByOverlap / scriptRequest / getSelectedText
 */
import { ref } from "vue";
import {
  createScriptView,
  createScriptOpen,
  runScriptFunction,
  runViewScript,
  hasScriptView,
  scopeScriptCss,
  SCRIPT_VIEW_ERROR_TIP,
  type ScriptEnv,
  type ScriptView,
} from "../../lib/script-runtime";
import { extractTagsAndCleanContent } from "../../lib/tags";
import { overlapMatchingDegreeForObjectArray } from "../../lib/overlap";
import { linksToString, SEARCH_BOUNDARY, SPECIAL_KEYWORD, type SearchEngine } from "../../lib/search-engine";
import {
  storageGet,
  storageSet,
  storageRemove,
  md2html,
} from "../../lib/util";
import {
  openExternal,
  hideWindow,
  httpRequest,
} from "../../lib/tauri-bridge";
import type { SearchItem } from "../../types/index";

/** 当前脚本视图会话（还原油猴版 registry.script.SESSION_MS_SCRIPT_ENV） */
interface ScriptSession {
  item: SearchItem;
  sendListener: Array<(msg: string) => void>;
  mounted: boolean;
}

/** 脚本视图挂载所需的宿主回调 */
export interface ScriptHostOptions {
  engine: SearchEngine;
  /** 视图高度自适应（由 DetailView 提供） */
  fitHeight: () => void;
  /** 立即下发窗口高度（由 DetailView 提供） */
  flushHeight: () => void;
  /** 退出详情视图（脚本内 triggerSearchHandle 会用到） */
  hideTextView: () => void;
  /** 执行一次搜索（脚本内 triggerSearchHandle 用） */
  doSearch: (keyword: string) => void;
  /** 读取搜索框当前值（挂载完成后自动转发子关键词用） */
  getInputValue: () => string;
  /** 改写搜索框当前值（自动转发后清掉子关键词用） */
  setInputValue: (keyword: string) => void;
}

export function useScriptHost(opts: ScriptHostOptions) {
  /** 当前脚本视图会话 */
  let scriptSession: ScriptSession | null = null;

  /** 会话是否处于挂载态（供 ResizeObserver 判断） */
  const sessionActive = ref(false);

  /** 类 AI 匹配度搜索（还原 registry.script.MS_SCRIPT_ENV_TEMPLATE.matchSearch） */
  async function matchSearchByOverlap(rawKeyword: string): Promise<SearchItem[]> {
    const keyword = String(rawKeyword ?? "").toUpperCase();
    if (!keyword.trim()) return [];
    const scopeOf = (item: SearchItem): Record<string, number> => {
      const { tags, cleaned } = extractTagsAndCleanContent(String(item.title ?? ""));
      return {
        [cleaned.toUpperCase()]: 9,
        [`${item.desc ?? ""}${tags.join()}`.toUpperCase()]: 8,
        [`${linksToString(item.links)}${item.resource ?? ""}${item.vassal ?? ""}`
          .substring(0, 4096)
          .toUpperCase()]: 2,
      };
    };
    try {
      return overlapMatchingDegreeForObjectArray<SearchItem>(
        keyword,
        [...opts.engine.searchData],
        scopeOf,
        { onlyHasScope: true }
      );
    } catch (e) {
      console.warn("[我的搜索] 类AI匹配搜索异常:", e);
      return [];
    }
  }

  /**
   * 让用户手动选择页面文本（还原 getSelectedText）：
   * 提示后隐藏搜索窗，等用户在其它应用里划选定文字（mouseup）再返回。
   */
  function getSelectedText(tis = "请选择页面文本"): Promise<string> {
    return new Promise((resolve) => {
      const box = document.getElementById("my_search_box");
      const tipElement = document.createElement("p");
      tipElement.textContent = tis;
      Object.assign(tipElement.style, {
        position: "fixed",
        top: "0",
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "black",
        color: "white",
        padding: "10px 20px",
        fontSize: "16px",
        zIndex: "9999",
        borderRadius: "5px",
      });
      document.body.appendChild(tipElement);
      // 本桌面版没有「被搜索的网页」：隐藏搜索窗让用户去其它应用里选文本
      void hideWindow();
      const onMouseUp = () => {
        const selected = String(window.getSelection?.() ?? "").trim();
        if (!selected) return;
        tipElement.remove();
        if (box) box.style.display = "";
        document.removeEventListener("mouseup", onMouseUp);
        resolve(selected);
      };
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  /**
   * 脚本应用的 HTTP 请求（还原 request）：
   * 原版走 GM_xmlhttpRequest / $.ajax，桌面版统一走 Rust 代理（绕开 CORS）。
   */
  function scriptRequest(
    type = "GET",
    url?: string,
    { query, body, header = {}, headers = {} }: {
      query?: Record<string, string>;
      body?: unknown;
      header?: Record<string, string>;
      headers?: Record<string, string>;
    } = {}
  ): Promise<string> {
    const allHeaders = { ...header, ...headers };
    let target = String(url ?? "");
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      target += (target.includes("?") ? "&" : "?") + qs;
    }
    if (!target) return Promise.reject(new Error("请求地址为空"));
    return httpRequest(target, {
      method: String(type || "GET").toUpperCase(),
      headers: allHeaders,
      body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }).then((result) => (typeof result === "string" ? result : JSON.stringify(result)));
  }

  /**
   * 为脚本视图提供与油猴版兼容的 API（还原 registry.script.MS_SCRIPT_ENV_TEMPLATE）
   *
   * 官方订阅中的脚本应用（如「AI」「CKEditor-本地编辑器」）会直接依赖这些接口，
   * 缺失时脚本自身会判定「当前脚本缺少所需API支持」并进入降级分支。
   */
  function createScriptEnv(session: Partial<ScriptSession> = {}): ScriptEnv {
    return {
      event: { sendListener: session.sendListener || [] },
      cache: {
        get: (k) => storageGet("script:" + k, null),
        set: (k, v) => storageSet("script:" + k, v),
        remove: (k) => storageRemove("script:" + k),
      },
      getSearchDB: () => [...opts.engine.searchData],
      getSelectedText: () => getSelectedText(),
      md2html: (raw) => md2html(raw),
      request: (type, url, o) => scriptRequest(type, url, o),
      matchSearch: (kw) => matchSearchByOverlap(kw),
      data: {
        get: () => [...opts.engine.searchData],
        matchSearch: () => [],
        distinct: (items) =>
          removeDuplicates(items as unknown as Record<string, unknown>[]) as unknown as SearchItem[],
      },
    };
  }

  /** 去掉数组里的重复项（还原 removeDuplicates，默认按 title + desc 比较） */
  function removeDuplicates(
    objs: Record<string, unknown>[],
    props: string[] = ["title", "desc"]
  ): Record<string, unknown>[] {
    if (!Array.isArray(objs) || objs.length === 0) return [];
    const keyOf = (obj: Record<string, unknown> | null | undefined) =>
      props.map((p) => String(obj?.[p] ?? "\u0000")).join("\u0001");
    const seen = new Set<string>();
    const result: Record<string, unknown>[] = [];
    for (const item of objs) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  /** 外部打开（带页面模拟器时降级为直接打开；还原 open().simulator()） */
  function createLocalScriptOpen() {
    return createScriptOpen((url: string) => void openExternal(url));
  }

  /** 结束脚本视图会话（还原 registry.script.clearMSSE） */
  function clearScriptSession(): void {
    if (scriptSession == null) return;
    const listeners = scriptSession.sendListener || [];
    listeners.length = 0;
    scriptSession = null;
    sessionActive.value = false;
    try {
      delete (window as unknown as Record<string, unknown>).MS_SCRIPT_ENV;
    } catch (e) {
      (window as unknown as Record<string, unknown>).MS_SCRIPT_ENV = undefined;
    }
  }

  /**
   * 向脚本视图推送「子搜索关键词」（还原 registry.script.tryRunTextViewHandler）：
   * - 挂载完成后自动调用：输入框已是「问AI : 你好」时，把「你好」交给应用（原版行为）；
   * - 在脚本视图上输入 `xx : 关键词` 回车时，把子关键词交给脚本处理。
   *
   * 与原版一致的判定：只要处于脚本视图会话且输入框含分隔符，就视为已处理——
   * 子关键词为空也吞掉（原版 getSubSearchKeyword 返回 ""，不是 undefined）。
   *
   * @returns handled=true 表示已交给脚本处理（不应再执行结果项点击）；
   *          nextKeyword=清掉子关键词后的输入框值（原版 `input.val(rawKeyword.replace(msg,""))`，
   *          保留「父关键词 : 」以便连续追问）。
   */
  function tryRunScriptTextViewHandler(rawKeyword: string): {
    handled: boolean;
    nextKeyword: string;
  } {
    if (scriptSession == null || !sessionActive.value) {
      return { handled: false, nextKeyword: rawKeyword };
    }
    const session = scriptSession;
    if (session.item == null || session.mounted !== true) {
      return { handled: false, nextKeyword: rawKeyword };
    }
    const parts = String(rawKeyword).split(SEARCH_BOUNDARY);
    if (parts.length < 2) return { handled: false, nextKeyword: rawKeyword };
    const msg = (parts[1] || "").trim();
    const listeners = session.sendListener || [];
    listeners.forEach((listener) => {
      try {
        listener(msg);
      } catch (e) {
        console.warn("[我的搜索] 脚本消息监听异常:", e);
      }
    });
    // 原版 input.val(rawKeyword.replace(msg,""))：只清掉刚发送的子关键词，
    // 保留「父关键词 : 」以便连续追问。
    const nextKeyword = msg === "" ? String(rawKeyword) : String(rawKeyword).replace(msg, "");
    return { handled: true, nextKeyword };
  }

  /** 脚本视图内的局部 $ 选择器（还原注册表里的 $） */
  function makeLocalQuery(wrap: HTMLElement) {
    return function $<T extends Element = Element>(sel: string, all = false): T | T[] | null {
      if (typeof sel !== "string") return null;
      return all
        ? ([...wrap.querySelectorAll(sel)] as unknown as T[])
        : (wrap.querySelector(sel) as T | null);
    };
  }

  /**
   * 提供给脚本的部分 registry（部分脚本会访问 registry.searchData 等）
   */
  function buildMiniRegistry(wrap: HTMLElement | null) {
    const query = wrap ? makeLocalQuery(wrap) : null;
    return {
      searchData: {
        getData: () => [...opts.engine.searchData],
        triggerSearchHandle: (kw?: string) => {
          const next = kw == null ? opts.engine.searchData.length : kw;
          opts.hideTextView();
          void opts.doSearch(String(next));
        },
        specialKeyword: SPECIAL_KEYWORD,
        version: opts.engine.searchData.length,
      },
      view: { element: wrap ? { textView: wrap } : {} },
      $: query,
    };
  }

  /**
   * 挂载脚本视图（view:html + view:css + view:js）。
   * @param host 脚本视图容器（.script-view 元素，由 DetailView 渲染）
   * @param owner #text_show 元素（style 标签挂在它下面，与原版一致）
   */
  function mountScriptView(
    item: SearchItem,
    host: HTMLElement,
    owner: HTMLElement,
    afterCallback: (() => void) | null = null
  ): void {
    const ro = item.resourceObj || {};

    if (scriptSession) scriptSession.mounted = true;
    sessionActive.value = true;

    // 注入脚本样式（作用域限定，避免污染主界面）。
    // 注意：不要用 owner.innerHTML = ""（#text_show 由 Vue 托管，清空会破坏 vdom），
    // 只操作自己 insert 的 style 节点与 host（.script-view，Vue 允许其内部由脚本自管）。
    clearScriptStyles(owner);
    if (ro["view:css"]) {
      const style = document.createElement("style");
      style.className = "ms-script-style";
      style.textContent = scopeScriptCss(ro["view:css"]);
      owner.insertBefore(style, host);
    }
    host.innerHTML = ro["view:html"] || "";

    // view:html 中的 <script src> 在 innerHTML 下不会执行，手动重建
    host.querySelectorAll("script").forEach((old) => {
      const s = document.createElement("script");
      if (old.src) s.src = old.src;
      else s.textContent = old.textContent;
      old.replaceWith(s);
    });

    const runViewJs = () => {
      if (!ro["view:js"]) return;
      const env = createScriptEnv(scriptSession || {});
      try {
        // 原版 openSessionForMSSE() 会把接口挂到页面 window 上（脚本会读 window.MS_SCRIPT_ENV）
        (window as unknown as Record<string, unknown>).MS_SCRIPT_ENV = env;
        // 包一层 IIFE：同一页面多次执行时变量/函数互相隔离（与原版 textView.show 一致）
        const verdict = runViewScript(ro["view:js"], {
          cache: env.cache,
          $: makeLocalQuery(host),
          view: { mount() {} },
          registry: buildMiniRegistry(host),
          open: createLocalScriptOpen(),
          MS_SCRIPT_ENV: env,
          request: env.request,
          md2html: env.md2html,
          data: env.data,
          event: env.event,
        });
        if (!verdict.ok) throw verdict.error;
      } catch (e) {
        console.warn("[我的搜索] 脚本视图执行异常:", e);
        const tip = document.createElement("div");
        tip.className = "script-view-tip";
        tip.textContent = SCRIPT_VIEW_ERROR_TIP;
        host.prepend(tip);
      }
    };

    // 等 view:html 的外部 <script src>（如 CKEditor）先加载，再执行 view:js
    waitViewRenderingComplete(() => {
      runViewJs();
      // 挂载完成即把输入框里的子关键词转发给脚本应用（还原原版
      // view.mount() → waitViewRenderingComplete(() => registry.script.tryRunTextViewHandler())）：
      // 这就是「问AI : 你好」在打开「问AI」应用后能立刻把「你好」交给应用的原因。
      const pushed = tryRunScriptTextViewHandler(opts.getInputValue());
      if (pushed.handled) opts.setInputValue(pushed.nextKeyword);
      if (afterCallback != null) afterCallback();
      opts.fitHeight();
      opts.flushHeight();
    });
  }

  /** 移除上次会话注入的脚本样式（只删自己插入的节点） */
  function clearScriptStyles(owner: HTMLElement): void {
    owner.querySelectorAll(":scope > style.ms-script-style").forEach((el) => el.remove());
  }

  /** 视图渲染完成回调（还原 waitViewRenderingComplete：setTimeout 30ms） */
  function waitViewRenderingComplete(callback: () => void): void {
    setTimeout(callback, 30);
  }

  /**
   * 运行脚本项：执行其 script 段（还原 Function('obj', `(${jscript})(obj)`)({...})）
   */
  function runScriptItem(
    item: SearchItem,
    onViewMountRequested: (cb: (() => void) | null) => void
  ): { ok: boolean } {
    const ro = item.resourceObj || {};
    const script = ro.script;
    if (script == null) {
      // 与油猴版一致的兜底提示
      window.alert?.("- _ - 脚本异常！");
      return { ok: false };
    }
    // 新的脚本视图会话（还原 openSessionForMSSE / clearMSSE）
    scriptSession = { item, sendListener: [], mounted: false };
    sessionActive.value = false;
    const env = createScriptEnv(scriptSession);
    (window as unknown as Record<string, unknown>).MS_SCRIPT_ENV = env;
    const view = createScriptView({
      mount: (afterCallback) => {
        onViewMountRequested(afterCallback);
      },
    });
    const verdict = runScriptFunction(
      script,
      {
        cache: env.cache,
        $: null,
        view,
        registry: { script: { SESSION_MS_SCRIPT_ENV: env } },
        open: createLocalScriptOpen(),
        MS_SCRIPT_ENV: env,
        request: env.request,
        md2html: env.md2html,
        data: env.data,
        event: env.event,
      },
      { view }
    );
    if (!verdict.ok) {
      console.warn("[我的搜索] 脚本项执行失败:", verdict.error);
      return { ok: false as const };
    }
    return { ok: true as const };
  }

  /** 当前脚本视图是否处于挂载态（DetailView 的 ResizeObserver 用） */
  function isSessionMounted(): boolean {
    return scriptSession != null && sessionActive.value;
  }

  return {
    createScriptEnv,
    clearScriptSession,
    tryRunScriptTextViewHandler,
    mountScriptView,
    runScriptItem,
    hasScriptView,
    isSessionMounted,
    // 供插件宿主复用：取选中文本 / 类 AI 匹配搜索（插件兼容模式下等价老脚本能力）
    getSelectedText,
    matchSearchByOverlap,
  };
}

export type ScriptHostApi = ReturnType<typeof useScriptHost>;
export type { ScriptView };
