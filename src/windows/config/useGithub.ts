/**
 * GitHub API + TisHub 订阅市场（还原油猴版 GithubAPI / TisHub）。
 */
import { httpRequest } from "../../lib/tauri-bridge";
import { parseAllDesignatedSingTags, parseTis } from "../../lib/subscribe-parser";
import { storageGet, storageRemove, storageSet } from "../../lib/util";
import { TOKEN_KEY, tokenVersion } from "./configShared";
import type { TisHubEntry } from "../../types/index";

/** GitHub Issues 返回的条目（只取用到的字段） */
interface GithubIssue {
  user: { login: string; html_url: string };
  title: string;
  body: string | null;
  state: string;
}

/** GitHub Issues 搜索响应 */
interface GithubIssueSearchResponse {
  items?: GithubIssue[];
}

export function createGithubApi(
  askToken: () => Promise<string | null>,
  onTokenChanged: () => void
) {
  const api = {
    clearToken(): void {
      storageRemove(TOKEN_KEY);
      tokenVersion.v++; // 通知 PanelRepo 刷新
      onTokenChanged();
    },
    /** 同步读取已缓存 Token */
    getToken(): string | null {
      return storageGet<string | null>(TOKEN_KEY, null);
    },
    /**
     * 确保拿到 Token：已缓存则直接返回，否则弹出输入框并等待用户输入
     * （还原油猴版 setToken/prompt 语义，但改为异步等待）
     */
    async requestToken(): Promise<string | null> {
      const cached = storageGet<string | null>(TOKEN_KEY, null);
      if (cached != null && cached !== "") return cached;
      const value = await askToken();
      if (value == null || value === "") return null;
      storageSet(TOKEN_KEY, value);
      tokenVersion.v++; // 通知 PanelRepo 刷新
      onTokenChanged();
      return value;
    },
    baseRequest(
      type: string,
      url: string,
      { query, body, headers }: {
        query?: Record<string, string | number>;
        body?: unknown;
        headers?: Record<string, string>;
      } = {}
    ): Promise<unknown> {
      let full = url;
      if (query) {
        const q = new URLSearchParams(
          Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
        ).toString();
        if (q) full += (full.includes("?") ? "&" : "?") + q;
      }
      const h: Record<string, string> = { ...(headers || {}) };
      const token = storageGet<string | null>(TOKEN_KEY, null);
      if (token && !h.Authorization) h.Authorization = `Bearer ${token}`;
      return httpRequest(full, {
        method: type,
        headers: h,
        body: body == null ? undefined : (body as Record<string, unknown>),
      });
    },
    getUserInfo(): Promise<unknown> {
      return this.baseRequest("GET", "https://api.github.com/user");
    },
    commitIssues(body: unknown): Promise<unknown> {
      const token = storageGet<string | null>(TOKEN_KEY, null);
      return this.baseRequest("POST", "https://api.github.com/repos/My-Search/TisHub/issues", {
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    // get issues 不要加 Authorization 头，可能会出现 401
    getTisForIssues({ keyword, state }: { keyword?: string; state?: string } = {}): Promise<GithubIssue[]> {
      if (keyword) {
        return this.baseRequest(
          "GET",
          `https://api.github.com/search/issues?q=repo:My-Search/TisHub+state:${state}+in:title+${keyword}`,
          { headers: {} }
        )
          .then((response) => (response as GithubIssueSearchResponse | null)?.items || [])
          .catch(() => []);
      }
      const query = state != null ? { state } : undefined;
      return this.baseRequest("GET", "https://api.github.com/repos/My-Search/TisHub/issues", {
        query,
        headers: {},
      }) as Promise<GithubIssue[]>;
    },
  };
  return api;
}

export type GithubApi = ReturnType<typeof createGithubApi>;

/** TisHub 订阅市场（还原 TisHub） */
export function createTisHub(github: GithubApi) {
  return {
    tisFilter(source: unknown, filterList: unknown): string[] {
      let src: string[];
      let filters: string[];
      if (typeof source === "string") {
        src = parseTis(source);
      } else {
        src = Array.isArray(source) ? (source as string[]) : [];
      }
      if (typeof filterList === "string") {
        filters = parseTis(filterList);
      } else {
        filters = Array.isArray(filterList) ? (filterList as string[]) : [];
      }
      for (const filterItem of filters) {
        const tabMetaInfos = parseAllDesignatedSingTags(String(filterItem), "tis");
        let subscribedLink: string | null = null;
        if (tabMetaInfos != null && tabMetaInfos.length > 0) {
          subscribedLink = tabMetaInfos[0].tabValue;
        }
        if (subscribedLink == null) subscribedLink = filterItem;
        src = src.filter((resultSubscribed) => !String(resultSubscribed).includes(subscribedLink));
      }
      return src;
    },
    getTisHubAllTis(filterList: unknown[] = []): Promise<string[]> {
      return Promise.all([this.getOpenIssuesTis(), this.getClosedIssuesTis()]).then((values) => {
        const result: string[] = [];
        for (const value of values) {
          if (value == null) continue;
          for (const tisListObj of value) {
            if (tisListObj != null) result.push(...tisListObj.tisList);
          }
        }
        return this.tisFilter(result, filterList);
      });
    },
    // {keyword,state}，其中 state {open, closed, all}
    getTisForIssues(params: { keyword?: string; state?: string } = {}): Promise<TisHubEntry[]> {
      return new Promise((resolve) => {
        github
          .getTisForIssues(params)
          .then((response) => {
            if (response != null && Array.isArray(response)) {
              resolve(
                response.map((obj) => ({
                  owner: obj.user.login,
                  ownerProfile: obj.user.html_url,
                  title: obj.title,
                  tisList: parseTis(obj.body),
                  status: obj.state,
                }))
              );
            } else {
              resolve([]);
            }
          })
          .catch(() => resolve([]));
      });
    },
    getOpenIssuesTis(params: { keyword?: string; state?: string } = {}): Promise<TisHubEntry[]> {
      return this.getTisForIssues({ state: "open", ...params });
    },
    getClosedIssuesTis(params: { keyword?: string; state?: string } = {}): Promise<TisHubEntry[]> {
      return this.getTisForIssues({ state: "closed", ...params });
    },
  };
}

export type TisHubApi = ReturnType<typeof createTisHub>;
