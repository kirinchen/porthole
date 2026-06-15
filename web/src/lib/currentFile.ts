/**
 * currentFile — 目前在 Explore 預覽的檔(path + 原始內容),供 ContentPick 推算行號。
 * 純模組變數;Explore 選檔時更新,切 repo / 清空時設 null。
 */
let cur: { path: string; content: string } | null = null;

export function setCurrentFile(f: { path: string; content: string } | null): void {
  cur = f;
}

export function getCurrentFile(): { path: string; content: string } | null {
  return cur;
}
