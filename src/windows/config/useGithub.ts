/**
 * GitHub API + TisHub 订阅市场（还原油猴版 GithubAPI / TisHub）。
 *
 * 注：应用内不再支持「提交订阅到 TisHub」（由用户自行前往 TisHub 仓库提 Issue），
 * 因此这里不再维护 GitHub Token，也不再带 Authorization 头。
 */
import { httpRequest } from "../../lib/tauri-bridge";
import { parseTis } from "../../lib/subscribe-parser";
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

export function createGithubApi() {
  const api = {
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
      return httpRequest(full, {
        method: type,
        headers: h,
        body: body == null ? undefined : (body as Record<string, unknown>),
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
