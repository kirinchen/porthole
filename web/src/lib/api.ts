/**
 * api client — 對 Fastify 後端的薄封裝。
 * repo 走 URL path 第一段;API 路徑 /api/:repo/...
 */

export interface TreeItem {
  name: string;
  path: string;
  type: 'dir' | 'file';
  mtime?: number; // 修改時間(ms);僅帶 stat 時有
  size?: number; // 檔案大小(bytes);dir 無,僅帶 stat 時有
}

export interface SearchMatch {
  line: number; // 1-based
  col: number; // 命中在片段內的起始 index
  len: number; // 命中長度
  text: string; // 該行片段(過長則開窗 + 前綴 …)
}
export interface SearchFile {
  path: string;
  matches: SearchMatch[];
}

export interface ThreadMeta {
  name: string;
  mtime: number;
  /** 顯示標題 = 檔首 H1(可中文);舊檔沒有 → null,顯示時退回 name。 */
  title?: string | null;
  /** 綁的檔(repo 相對路徑,來自檔內 `<!-- porthole:link -->`);沒綁 → null。 */
  link?: string | null;
}

/** 那一輪 claude -p 還在跑嗎(後端 job registry;後端重啟過 → null)。 */
export interface ChatJob {
  state: 'running';
  startedAt: number;
  model: string | null;
  effort: string | null;
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export const api = {
  repos: () => jget<{ base: string; repos: string[] }>('/api/repos'),

  tree: (repo: string, path = '.', stat = false) =>
    jget<{ items: TreeItem[] }>(
      `/api/${repo}/tree?path=${encodeURIComponent(path)}${stat ? '&stat=1' : ''}`,
    ),

  file: (repo: string, path: string) =>
    jget<{ content: string; markdown: boolean; ext: string }>(
      `/api/${repo}/file?path=${encodeURIComponent(path)}`,
    ),

  /** 跨檔內容搜尋(find in files);path-guard 在後端把關。 */
  search: (
    repo: string,
    q: string,
    opts: { regex?: boolean; caseSensitive?: boolean } = {},
  ) =>
    jget<{ results: SearchFile[]; truncated: boolean }>(
      `/api/${encodeURIComponent(repo)}/search?q=${encodeURIComponent(q)}` +
        `${opts.regex ? '&regex=1' : ''}${opts.caseSensitive ? '&case=1' : ''}`,
    ),

  /** 原始位元組 URL(圖片 <img src> 用);path-guard 在後端把關。 */
  rawUrl: (repo: string, path: string) =>
    `/api/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(path)}`,

  /** 下載 URL(attachment,帶檔名);給 <a download> 觸發瀏覽器下載。 */
  downloadUrl: (repo: string, path: string) =>
    `/api/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(path)}&download=1`,

  writeFile: async (
    repo: string,
    path: string,
    content: string,
    encoding: 'utf8' | 'base64' = 'utf8',
  ) => {
    const r = await fetch(`/api/${repo}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, encoding }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  makeDir: async (repo: string, path: string) => {
    const r = await fetch(`/api/${repo}/dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  deletePath: async (repo: string, path: string) => {
    const r = await fetch(`/api/${repo}/fs?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  renamePath: async (repo: string, from: string, to: string) => {
    const r = await fetch(`/api/${repo}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  threads: (repo: string) => jget<{ threads: ThreadMeta[] }>(`/api/${repo}/chat/threads`),

  thread: (repo: string, name: string) =>
    jget<{ content: string }>(`/api/${repo}/chat/threads/${encodeURIComponent(name)}`),

  /** to 有給 → 手動改名;否則 claude 依主題自動命名(中文標題 + 英文 slug)。
   *  回傳實際採用的檔名(可能加 -2 防衝突)與顯示標題;純中文輸入只改標題、檔名不動。
   *  綁檔的 thread 只換 `<slug>` 段,`-<file>-<hex12>` 後綴不動。 */
  renameThread: async (repo: string, name: string, to?: string) => {
    const r = await fetch(`/api/${repo}/chat/threads/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      headers: to ? { 'Content-Type': 'application/json' } : undefined,
      body: to ? JSON.stringify({ to }) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { name: string; title?: string | null; link?: string | null };
  },

  /** 某個檔的預設對話是哪一條(SPEC §4.2.1)。exists=false → 名字是建議值,還沒落檔。 */
  threadForFile: (repo: string, path: string) =>
    jget<{ name: string; title: string | null; exists: boolean }>(
      `/api/${encodeURIComponent(repo)}/chat/for-file?path=${encodeURIComponent(path)}`,
    ),

  /** 那輪還在跑嗎。 */
  chatJob: (repo: string, thread: string) =>
    jget<{ job: ChatJob | null }>(`/api/${repo}/chat/jobs/${encodeURIComponent(thread)}`),

  /** 中斷那輪(SIGTERM 那支 claude -p;已寫出的 turn 不回捲)。 */
  cancelChat: async (repo: string, thread: string) => {
    const r = await fetch(`/api/${repo}/chat/jobs/${encodeURIComponent(thread)}`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  /** ⚙ 下拉的選項(model / effort 白名單由後端給,前端不自己編)。 */
  chatEngine: () =>
    jget<{ engine: string; models: string[]; efforts: string[] }>('/api/chat/engine'),
};
