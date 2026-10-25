/**
 * chat-link — 綁檔對話(file-linked chat)的檔名與 link 註記,**純邏輯不碰 fs**(好測)。
 *
 * 規則(SPEC §4.2.1):`doc/chat/<slug>-<file>-<hex12>.md`
 *   - `<slug>`  主題 slug(首輪自動命名產生;還沒命名時 `chat`)
 *   - `<file>`  綁的檔名含副檔名,`.` → `-`、其餘非 [A-Za-z0-9_-] → `_`、截 48
 *   - `<hex12>` sha256(repo 相對**資料夾**路徑) 前 12 碼;同名檔在不同夾不會撞,
 *               而且資料夾多深,檔名都只多 12 個字(直接把路徑塞進檔名會長到難看)
 *
 * **權威來源是檔案裡的 link 註記,不是檔名**:檔名會被改名 / 搬動,註記不會。
 *   `<!-- porthole:link doc/note/foo.md -->`
 */
import { createHash } from 'node:crypto';

/**
 * 檔名(含副檔名)→ 檔名片段。`.` 換 `-` 是為了讓 `.md` 這類副檔名還看得出來。
 *
 * 非 ASCII 一律換成 `_`(檔名不收中文,SPEC §9.3),所以**兩個不同的中文檔名可能得到同一個片段**
 * (`我的筆記.md` 與 `你的筆記.md` 都是 `___-md`)。這不會讓兩條對話混在一起 ——
 * 建立時會比對既有檔的 link 註記,撞到別的檔就加 `-2`(同 rename 的衝突策略),
 * 而反查以 link 註記為準(檔名只是給人看的)。
 */
export function fileSlug(basename: string): string {
  return (
    basename
      .replace(/\./g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/-{2,}/g, '-')
      .slice(0, 48)
      .replace(/^-+|-+$/g, '') || 'file'
  );
}

/** repo 相對資料夾路徑 → 12 碼 hex(repo 根目錄用空字串算)。 */
export function folderHex(dir: string): string {
  const norm = dir.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

/** repo 相對檔案路徑 → `{ dir, base }`(posix 語意,不碰 fs)。 */
export function splitRel(rel: string): { dir: string; base: string } {
  const norm = rel.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const i = norm.lastIndexOf('/');
  return i === -1 ? { dir: '', base: norm } : { dir: norm.slice(0, i), base: norm.slice(i + 1) };
}

/** 綁檔對話的檔名後綴 `-<file>-<hex12>`(反查用:檔名比不到就靠這個 suffix)。 */
export function linkSuffix(rel: string): string {
  const { dir, base } = splitRel(rel);
  return `-${fileSlug(base)}-${folderHex(dir)}`;
}

/** 組綁檔對話的 thread 名。slug 省略 / 空 → `chat`。 */
export function linkedThreadName(rel: string, slug?: string | null): string {
  const s = (slug ?? '').trim() || 'chat';
  return `${s}${linkSuffix(rel)}`;
}

/**
 * 換掉綁檔 thread 名的 `<slug>` 段、保留 `-<file>-<hex12>` 後綴(自動命名用)。
 * 名字沒有該後綴(= 不是這個檔的綁檔對話)→ 回 null,呼叫端照一般改名處理。
 */
export function reslug(name: string, rel: string, slug: string): string | null {
  const suf = linkSuffix(rel);
  if (!name.endsWith(suf)) return null;
  const s = slug.trim() || 'chat';
  return `${s}${suf}`;
}

const LINK_RE = /<!--\s*porthole:link\s+(\S[^>]*?)\s*-->/;
/** 掃檔頭找 link 註記 → repo 相對路徑;沒有則 null。只看前 4KB 的呼叫端自己截。 */
export function readLink(content: string): string | null {
  const m = LINK_RE.exec(content);
  return m ? m[1].trim() : null;
}

/** 寫入 / 取代 link 註記。沒有 H1 就放檔首;有 H1 則緊接在 H1 下一行。 */
export function setLink(content: string, rel: string): string {
  const line = `<!-- porthole:link ${rel} -->`;
  if (LINK_RE.test(content)) return content.replace(LINK_RE, line);
  const lines = content.split('\n');
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 === -1) return `${line}\n${content.startsWith('\n') ? '' : '\n'}${content}`;
  lines.splice(h1 + 1, 0, line);
  return lines.join('\n');
}

/**
 * 綁檔對話送出時的脈絡前綴(SPEC §4.2.1 / kelp in-context-agent-chat.md 的「自動附上脈絡」)。
 * 能力本來就在(claude -p 的 CWD 已是 repo root 且過 path-guard);這裡補的是脈絡 + 明確授權 + 回報格式。
 */
export function linkContext(repo: string, rel: string): string {
  return (
    '[porthole 脈絡]\n' +
    `repo: ${repo}\n` +
    `開著的檔: ${rel}\n` +
    '這段對話綁在上面那個檔上。你可以直接讀寫它(CWD 已在 repo root)。\n' +
    '若你改了檔,回報:改了什麼 → 為什麼 → 還有什麼沒做。\n\n'
  );
}
