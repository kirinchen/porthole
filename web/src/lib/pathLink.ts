/**
 * pathLink — 解析 markdown 連結 href → porthole 導航目標。
 *
 * 規則:
 *  - 外部(其他協定 mailto: 等、或 http(s) 指向其他 host)→ external,新分頁開。
 *  - 本站完整 URL `http(s)://<本host>/<repo>/<path>#<tab>` → internal。
 *  - 站內絕對路徑 `/<repo>/<path>#<tab>` → internal。
 *  - 相對路徑(含 `.` / `..`,以「目前檔案所在目錄」為基準)→ internal(同 repo)。
 *  - 純錨點 `#tab` → internal(同檔,只帶 tab)。
 *  tab 只認 explore/chat/session/cli,其餘 hash 視為無 tab。
 *  目標是檔案或資料夾由呼叫端(Explore)實際嘗試開啟時判定;本檔只負責解析路徑。
 */
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'internal'; repo: string; path: string; tab?: string };

const TABS = ['explore', 'chat', 'session', 'cli'];

function tabFromHash(hash: string): string | undefined {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  return TABS.includes(h) ? h : undefined;
}

/** 以 '/' 切段、處理 '.'(略過)與 '..'(往上一層),回傳正規化路徑。 */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** 取目錄(去最後一段);頂層回 ''。 */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function splitHash(s: string): [string, string] {
  const i = s.indexOf('#');
  return i >= 0 ? [s.slice(0, i), s.slice(i)] : [s, ''];
}

/** 解析站內 pathname(`/<repo>/<path>`)+ hash → internal target。 */
function parseInternalPath(pathname: string, hash: string): LinkTarget {
  const segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const repo = segs[0] ?? '';
  const path = segs.slice(1).join('/');
  return { kind: 'internal', repo, path, tab: tabFromHash(hash) };
}

/**
 * 解析 href。curRepo / curFilePath = 目前 repo 與目前開啟檔(相對路徑基準)。
 * 回傳 null = 無法導航(空字串)。
 */
export function resolveLink(href: string, curRepo: string, curFilePath: string): LinkTarget | null {
  const raw = href.trim();
  if (!raw) return null;

  // 純錨點 #tab → 同檔切 tab
  if (raw.startsWith('#')) {
    return { kind: 'internal', repo: curRepo, path: curFilePath, tab: tabFromHash(raw) };
  }

  // 有協定
  const proto = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (proto) {
    const scheme = proto[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      try {
        const u = new URL(raw);
        if (u.host === location.host) return parseInternalPath(u.pathname, u.hash);
      } catch {
        /* 解析失敗 → 當外部 */
      }
    }
    return { kind: 'external', url: raw };
  }

  // 站內絕對路徑 /<repo>/<path>
  if (raw.startsWith('/')) {
    const [p, hash] = splitHash(raw);
    return parseInternalPath(p, hash);
  }

  // 相對路徑(含 ..)→ 以目前檔案所在目錄為基準,同 repo
  const [rel, hash] = splitHash(raw);
  const base = dirOf(curFilePath);
  const path = normalizePath(base ? `${base}/${rel}` : rel);
  return { kind: 'internal', repo: curRepo, path, tab: tabFromHash(hash) };
}
