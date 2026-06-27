/**
 * api client — 對 Fastify 後端的薄封裝。
 * repo 走 URL path 第一段;API 路徑 /api/:repo/...
 */

export interface TreeItem {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

export interface ClaudeSession {
  id: string;
  mtime: number;
  title: string;
}

export interface ThreadMeta {
  name: string;
  mtime: number;
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

  tree: (repo: string, path = '.') =>
    jget<{ items: TreeItem[] }>(`/api/${repo}/tree?path=${encodeURIComponent(path)}`),

  file: (repo: string, path: string) =>
    jget<{ content: string; markdown: boolean; ext: string }>(
      `/api/${repo}/file?path=${encodeURIComponent(path)}`,
    ),

  /** 原始位元組 URL(圖片 <img src> 用);path-guard 在後端把關。 */
  rawUrl: (repo: string, path: string) =>
    `/api/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(path)}`,

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

  /** to 有給 → 手動改名;否則 claude 依主題自動命名。回傳實際採用的名稱(可能加 -2 防衝突)。 */
  renameThread: async (repo: string, name: string, to?: string) => {
    const r = await fetch(`/api/${repo}/chat/threads/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      headers: to ? { 'Content-Type': 'application/json' } : undefined,
      body: to ? JSON.stringify({ to }) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { name: string };
  },

  sessions: (repo: string) => jget<{ sessions: ClaudeSession[] }>(`/api/${repo}/sessions`),

  startSession: async (
    repo: string,
    id: string,
    opts?: { yolo?: boolean; args?: string },
  ) => {
    const r = await fetch(`/api/${repo}/sessions/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { name: string };
  },

  newSession: async (
    repo: string,
    opts: { agent: string; yolo?: boolean; args?: string },
  ) => {
    const r = await fetch(`/api/${repo}/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
    return (await r.json()) as { name: string };
  },

  deleteSession: async (repo: string, id: string) => {
    const r = await fetch(`/api/${repo}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `HTTP ${r.status}`);
    }
  },

  tmuxList: () => jget<{ sessions: string[] }>('/api/tmux'),

  tmuxKill: async (name: string) => {
    const r = await fetch(`/api/tmux/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
};

/** WebSocket URL(同 origin,dev 由 vite proxy 轉)。 */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}
