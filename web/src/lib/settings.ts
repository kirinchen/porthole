/**
 * settings — 前端本機偏好(localStorage)。目前只有「新 session 用哪個 agent」。
 * 後端對 agent 另有白名單(server/routes/session.ts),這裡的選項需與其一致。
 */
const KEY = 'porthole.sessionAgent';

export const SESSION_AGENTS = ['claude', 'gemini'] as const;

export function getSessionAgent(): string {
  try {
    return localStorage.getItem(KEY) || 'claude';
  } catch {
    return 'claude';
  }
}

export function setSessionAgent(agent: string): void {
  try {
    localStorage.setItem(KEY, agent);
  } catch {
    /* localStorage 不可用 → 略過 */
  }
}

// 背景 tmux session 的別名(只改顯示,不動實際 tmux 名)。
const ALIAS_KEY = 'porthole.sessionAlias';

export function getAliases(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function setAlias(name: string, alias: string): void {
  const m = getAliases();
  const a = alias.trim();
  if (a) m[name] = a;
  else delete m[name];
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(m));
  } catch {
    /* 略過 */
  }
}
