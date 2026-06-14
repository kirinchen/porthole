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
