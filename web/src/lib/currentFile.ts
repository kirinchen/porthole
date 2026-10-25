/**
 * currentFile — 目前在 Explore 預覽的檔(path + 原始內容)。
 *  - ContentPick 用它推算行號。
 *  - App 用 `porthole:current-file` 事件知道「現在開著哪個檔」,好把右側對話切到
 *    那個檔的綁檔對話(SPEC §4.2.1)。模組變數不是 reactive,故改檔時派事件。
 * 純模組變數;Explore 選檔時更新,切 repo / 清空時設 null。
 */
let cur: { path: string; content: string } | null = null;

export const CURRENT_FILE_EVENT = 'porthole:current-file';

export function setCurrentFile(f: { path: string; content: string } | null): void {
  const before = cur?.path ?? null;
  cur = f;
  const after = f?.path ?? null;
  // 只有「換檔」才派事件 —— 編輯中每次改內容都會重設 cur,路徑沒變就別讓 App 重跑。
  if (before !== after) {
    window.dispatchEvent(new CustomEvent(CURRENT_FILE_EVENT, { detail: { path: after } }));
  }
}

export function getCurrentFile(): { path: string; content: string } | null {
  return cur;
}
