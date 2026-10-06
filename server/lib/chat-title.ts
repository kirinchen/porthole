/**
 * chat-title — Chat thread 的「檔名 vs 顯示標題」純邏輯(給 chat route 用,可單測)。
 *
 * 約定:**檔名一律英文 kebab-case slug**(跨工具 / git / URL 都安全);想看的中文放在
 * 檔案第一行 `# 標題`。顯示名因此跟著檔案走(搬移 / clone / 在 Explore 看都還在),
 * 不必另存一份 index 去 drift。舊檔(早期只 append turn)沒有 H1 → 讀出 null,
 * 前端退回顯示檔名。
 *
 * 這裡只有字串進字串出,不碰 fs —— 邊界(已有 H1 / 檔首空行 / 先遇到 turn 標頭)
 * 容易寫錯,故抽出來測。
 */

/** thread 名收斂成安全檔名(再交 path-guard 二次把關)。 */
export function safeThread(name: string): string {
  const s = String(name).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
  return s || 'default';
}

/** 任意文字 → kebab-case slug(只留小寫英數 + 連字號);取第一個非空行。 */
export function slugify(raw: string): string {
  const line = raw.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** 掃檔首的行數上限:標題只可能在最前面,不為它讀整個 thread。 */
const HEAD_LINES = 20;

/**
 * 檔首第一個 ATX H1(`# …`)= 顯示標題;沒有則 null。
 * 一遇到 `## `(turn 標頭)就停 —— 對話內文裡的 `# ` 不算標題。
 */
export function readH1(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, HEAD_LINES); i++) {
    if (/^##\s/.test(lines[i])) break; // 已進入 turn 區 → 檔首沒有 H1
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** 設定檔首 H1:已有則取代該行,沒有則插到最前面(與後文空一行)。 */
export function setH1(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, HEAD_LINES); i++) {
    if (/^##\s/.test(lines[i])) break;
    if (/^#\s+/.test(lines[i])) {
      lines[i] = `# ${title}`;
      return lines.join('\n');
    }
  }
  return `# ${title}\n${content.startsWith('\n') ? '' : '\n'}${content}`;
}

/**
 * 解析 genTitle 的 claude 輸出:第一行中文標題、第二行英文 slug。
 * claude 可能多吐空行或把標題寫成 `# 標題`,故逐行 trim、濾空、剝開頭的 `#`。
 */
export function parseGenTitle(out: string): { title: string; slug: string } {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    title: (lines[0] ?? '').replace(/^#+\s*/, '').slice(0, 80),
    slug: slugify(lines[1] ?? ''),
  };
}
