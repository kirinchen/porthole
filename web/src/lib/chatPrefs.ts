/**
 * chatPrefs — Chat 的本機偏好與草稿(localStorage)。
 *
 * 形狀參考 tide 的 `src/ui/draft.ts` / CommentPanel 的偏好處理:
 *  - **model / effort 是使用者偏好,不綁 thread**(換對話不該重新選一次)。
 *  - **草稿 per repo + thread**:沒送出的字換對話 / 重整都還在。
 *    刻意由 onChange 呼叫 `saveDraft`,**不要**用 useEffect —— 換 thread 那一瞬間
 *    value 還是舊對話的內容、key 已經是新對話的,用 effect 會把 A 的草稿存到 B 名下。
 *  - localStorage 在無痕 / 關掉 cookie 的情境會丟例外 → 一律 try/catch,記不住就算了。
 */
const MODEL_KEY = 'porthole.chat.model';
const EFFORT_KEY = 'porthole.chat.effort';
const DRAFT_PREFIX = 'porthole.chat.draft.';
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天沒碰就清掉

function read(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}
function write(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* 記不住就算了 */
  }
}

/** '' = 用 CLI 自己的預設。 */
export const getModel = () => read(MODEL_KEY);
export const setModel = (v: string) => write(MODEL_KEY, v);
export const getEffort = () => read(EFFORT_KEY);
export const setEffort = (v: string) => write(EFFORT_KEY, v);

/** 對話模式左欄(對話列表)的寬度。同 tide 的 `tide.cpanelW`:拖完存著,下次進來一樣寬。 */
const LIST_W_KEY = 'porthole.chat.listW';
export const LIST_W_MIN = 200;
export const LIST_W_DEFAULT = 280;

export function getListWidth(): number {
  const n = Number(read(LIST_W_KEY));
  return Number.isFinite(n) && n >= LIST_W_MIN ? n : LIST_W_DEFAULT;
}
export const setListWidth = (w: number) => write(LIST_W_KEY, String(Math.round(w)));

export const draftKey = (repo: string, thread: string) => `${DRAFT_PREFIX}${repo}/${thread}`;

export function loadDraft(key: string): string {
  const raw = read(key);
  if (!raw) return '';
  try {
    const d = JSON.parse(raw) as { v?: string };
    return d.v ?? '';
  } catch {
    return raw; // 舊格式(純字串)也讀得回來
  }
}

export function saveDraft(key: string, v: string): void {
  if (!v.trim()) {
    write(key, '');
    return;
  }
  write(key, JSON.stringify({ v, at: Date.now() }));
}

export const clearDraft = (key: string) => write(key, '');

/** 清掉太久沒碰的草稿(開 Chat 時順手跑一次)。 */
export function pruneDrafts(): void {
  try {
    const now = Date.now();
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(k) ?? '{}') as { at?: number };
        if (!d.at || now - d.at > DRAFT_TTL_MS) dead.push(k);
      } catch {
        dead.push(k); // 壞資料直接清
      }
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch {
    /* 略過 */
  }
}
