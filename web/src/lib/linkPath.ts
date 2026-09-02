/**
 * linkPath — 連結網址欄的路徑補全解析(純函式,好測)。
 *
 * VS Code 式:網址欄以 `.` / `..` / `/` 起手才進「站內路徑」模式,
 * `https://` 等外部網址完全不觸發。
 *
 *  - `.` / `./…`  → 以目前編輯檔所在目錄為基準
 *  - `..` / `../…`→ 往上一層(`..` 夾在 repo root,實際邊界仍由後端 path-guard 擋)
 *  - `/…`         → repo 根
 *
 * 解析結果 `{ dir, prefix, insertBase }`:
 *  - `dir`        送 `GET /api/:repo/tree` 的 repo 相對目錄(`''` = repo root)
 *  - `prefix`     用來過濾該層項目的字首
 *  - `insertBase` 選中項目時要保留的字面前綴 —— 保住使用者起手的 `./` `../` `/` 風格
 *
 * 檔名編碼:中文原樣保留(`pathLink.resolveLink` 會 safeDecode,repo 既有連結亦是原樣中文),
 * 只逸出會破壞 markdown `[t](url)` 語法的字元(空白與括號)。
 */
import { normalizePath } from './pathLink.ts';

export interface LinkPathQuery {
  /** 要列出的目錄,repo 相對('' = repo root)。 */
  dir: string;
  /** 過濾字首(該層項目名以此開頭者才列)。 */
  prefix: string;
  /** 選中項目時保留的字面前綴(維持 `./` `../` `/` 風格)。 */
  insertBase: string;
}

/** 網址是否為站內路徑表達式(只有 `.` / `/` 起手才算)。 */
export function isPathExpression(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/');
}

/**
 * 解析網址欄目前內容 → 要列的目錄 + 過濾字首。
 * `baseDir` = 目前編輯檔所在目錄(repo 相對,頂層為 '')。
 * 回 null = 不觸發補全(外部網址、含 `#` / `?` 的錨點/查詢字串)。
 */
export function parseLinkPathQuery(value: string, baseDir: string): LinkPathQuery | null {
  if (!isPathExpression(value)) return null;
  // 已帶錨點 / query 就不再補路徑(避免把 `#section` 當檔名前綴而蓋掉)。
  if (value.includes('#') || value.includes('?')) return null;

  const absolute = value.startsWith('/');
  const slash = value.lastIndexOf('/');

  // 無 '/':只可能是 `.`(本層)、`..`(上一層)或 `.foo` 這種同層隱藏檔字首。
  if (slash === -1) {
    if (value === '.') return { dir: normalizePath(baseDir), prefix: '', insertBase: './' };
    if (value === '..') return { dir: resolveDir(baseDir, '..', false), prefix: '', insertBase: '../' };
    // `.env` 之類:整串就是檔名字首,插入時不加前綴(維持裸相對檔名)。
    return { dir: normalizePath(baseDir), prefix: value, insertBase: '' };
  }

  const head = value.slice(0, slash + 1); // 含尾斜線
  const last = value.slice(slash + 1);

  // 最後一段是 `.` / `..` → 它是導航段而非過濾字首,整段納入基準目錄。
  if (last === '.' || last === '..') {
    const expr = head + last;
    return { dir: resolveDir(baseDir, expr, absolute), prefix: '', insertBase: `${expr}/` };
  }
  return { dir: resolveDir(baseDir, head, absolute), prefix: last, insertBase: head };
}

/** 把路徑表達式解成 repo 相對目錄;absolute 則忽略 baseDir。`..` 由 normalizePath 夾在 root。 */
function resolveDir(baseDir: string, expr: string, absolute: boolean): string {
  if (absolute) return normalizePath(expr);
  return normalizePath(baseDir ? `${baseDir}/${expr}` : expr);
}

// ---- 章節(`#section`)補全 ----

export interface LinkSectionQuery {
  /** 要列標題的檔(repo 相對);null = 目前編輯檔(`#` 起手,無路徑)。 */
  filePath: string | null;
  /** 過濾字首(以標題文字 / slug 比對)。 */
  query: string;
  /** 選中前要保留的字面(路徑段 + 單一 `#`;`##`/`###` 起手一律正規化成單一 `#`)。 */
  insertBase: string;
}

/**
 * 解析網址欄的「章節錨點」補全:含 `#` 時觸發。
 *  - `#foo` / `##foo`(無路徑)→ 目前編輯檔的標題(`#` 數量正規化,產出單一 `#slug`)。
 *  - `./a.md#foo`、`../x/y.md#foo`、`/a.md#foo` → 該檔的標題。
 * 回 null = 不觸發(外部網址 `scheme:`、或 `#` 後已含空白 / 斜線 → 不再是 slug 打字中)。
 */
export function parseLinkSectionQuery(value: string, baseDir: string): LinkSectionQuery | null {
  const hash = value.indexOf('#');
  if (hash < 0) return null;
  const head = value.slice(0, hash);
  if (/^[a-z][a-z0-9+.-]*:/i.test(head)) return null; // https: 等外部網址不碰
  const query = value.slice(hash).replace(/^#+/, ''); // 去起手的一或多個 #
  if (/[\s/]/.test(query)) return null; // slug 不含空白 / 斜線
  const filePath = head === '' ? null : resolveFilePath(baseDir, head);
  return { filePath, query, insertBase: `${head}#` }; // 正規化成單一 #
}

/** 把 `#` 前的路徑段解成 repo 相對檔路徑(相對目前檔目錄 / 絕對 / 裸檔名)。 */
function resolveFilePath(baseDir: string, head: string): string {
  if (head.startsWith('/')) return normalizePath(head);
  return normalizePath(baseDir ? `${baseDir}/${head}` : head);
}

/** 選中某標題 → 新的網址欄內容(路徑段 + `#` + slug)。 */
export function applyLinkSectionChoice(q: LinkSectionQuery, slug: string): string {
  return q.insertBase + slug;
}

/**
 * 選中某項目 → 新的網址欄內容。
 * 資料夾補尾斜線讓補全接著往下一層;檔名逸出會破壞 markdown 連結語法的字元。
 */
export function applyLinkPathChoice(q: LinkPathQuery, name: string, isDir: boolean): string {
  return q.insertBase + encodeLinkSegment(name) + (isDir ? '/' : '');
}

/** 上一層的 insertBase(給下拉的合成 `../` 項用),盡量維持使用者原本的風格。 */
export function parentInsertBase(insertBase: string): string {
  if (insertBase === '' || insertBase === './') return '../';
  if (/^(\.\.\/)+$/.test(insertBase)) return `${insertBase}../`; // 已在往上爬 → 再上一層
  const trimmed = insertBase.slice(0, -1); // 去尾斜線
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? './' : trimmed.slice(0, i + 1);
}

/**
 * 逸出檔名中會破壞 `[文字](網址)` 的字元。
 * 中文等非 ASCII 一律原樣(repo 既有連結慣例;`resolveLink` 讀取時 safeDecode 相容兩種)。
 */
export function encodeLinkSegment(name: string): string {
  return name.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
