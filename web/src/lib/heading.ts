/**
 * heading — markdown 標題的 slug 與章節定位(GitHub 式錨點)共用工具。
 *
 * slug 規則與 mentionComplete 的 `#section` 自動完成一致(空白→`-`,保留中文等),
 * 讓「標題錨點 / `#slug` 連結 / `?sec=` deep-link / 自動完成插入的章節連結」四者互通。
 */

/**
 * 去除 inline markdown 標記(粗體 / 斜體 / 刪除線 / 行內 code / 連結 / 圖片),留純文字。
 * 讓「原始碼標題文字」與「react-markdown 渲染後文字」正規化到同一結果 —— 兩者都經此再
 * slugify,slug 才會一致(否則含 inline markdown 的標題,錨點與 #section 自動完成會對不上)。
 */
export function stripInlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1') // `code`
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
    .replace(/__([^_]+)__/g, '$1') // __bold__
    .replace(/\*([^*]+)\*/g, '$1') // *italic*
    .replace(/_([^_]+)_/g, '$1') // _italic_
    .replace(/~~([^~]+)~~/g, '$1') // ~~strike~~
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1'); // [text](url) / ![alt](url)
}

/** 標題文字 → 單一 token slug(去 inline markdown、空白收成 `-`,其餘保留)。 */
export function slugifyHeading(h: string): string {
  return stripInlineMd(h.trim()).trim().replace(/\s+/g, '-');
}

/**
 * 同名 slug 去重(文件出現序):首個保持原樣,其後補 `-1` `-2`…(GitHub 式)。
 * Markdown 渲染與 mentionComplete 需以相同順序、相同 seen Map 呼叫,後綴才會對齊。
 */
export function dedupeSlug(base: string, seen: Map<string, number>): string {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** 屬性選擇器值逸出(slug 可能含 `.` `(` 等;只需逸出 `"` 與 `\`)。 */
function attrEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * 捲動到「目前 Explore 預覽」中對應 slug 的標題,附短暫高亮。回傳是否找到。
 * 以 data-heading-slug 在 .md-preview 內查找(避免與資料夾 README 的同名 id 撞、也免處理重複 id)。
 */
export function scrollToHeadingSlug(slug: string): boolean {
  const root = document.querySelector('[data-loc="explore:preview"] .md-preview');
  const el = root?.querySelector<HTMLElement>(`[data-heading-slug="${attrEscape(slug)}"]`) ?? null;
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('md-heading-flash');
  void el.offsetWidth; // 強制 reflow → 重複點擊也重播高亮動畫
  el.classList.add('md-heading-flash');
  window.setTimeout(() => el.classList.remove('md-heading-flash'), 1400);
  return true;
}
