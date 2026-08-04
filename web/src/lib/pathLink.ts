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
  | { kind: 'internal'; repo: string; path: string; tab?: string; section?: string };

const TABS = ['explore', 'chat', 'session', 'cli'];

function tabFromHash(hash: string): string | undefined {
  const h = safeDecode(hash.replace(/^#/, '')); // safeDecode:孤立 `%` 等壞編碼不炸掉整個預覽
  return TABS.includes(h) ? h : undefined;
}

/** hash 非 tab(explore/chat/…)時,視為章節錨點 slug(GitHub 式 `#標題`)。 */
function sectionFromHash(hash: string): string | undefined {
  const h = safeDecode(hash.replace(/^#/, ''));
  return h && !TABS.includes(h) ? h : undefined;
}

/** `?sec=<slug>` query → 章節 slug(複製功能產生的可分享連結格式)。 */
function sectionFromSearch(search: string): string | undefined {
  try {
    return new URLSearchParams(search).get('sec') || undefined;
  } catch {
    return undefined;
  }
}

/** 把 href 拆成 path / search(?…)/ hash(#…)三段。 */
function splitUrl(raw: string): { path: string; search: string; hash: string } {
  let rest = raw;
  let hash = '';
  const hi = rest.indexOf('#');
  if (hi >= 0) {
    hash = rest.slice(hi);
    rest = rest.slice(0, hi);
  }
  let search = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    search = rest.slice(qi);
    rest = rest.slice(0, qi);
  }
  return { path: rest, search, hash };
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

/** 安全 percent-decode(壞編碼則原樣回);路徑送 api 前須為 raw,否則 server 端會多一層 %。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 解析站內 pathname(`/<repo>/<path>`)+ hash + search → internal target。section:?sec= 優先於 #hash。 */
function parseInternalPath(pathname: string, hash: string, search = ''): LinkTarget {
  const segs = pathname.split('/').filter(Boolean).map((s) => safeDecode(s));
  const repo = segs[0] ?? '';
  const path = segs.slice(1).join('/');
  return {
    kind: 'internal',
    repo,
    path,
    tab: tabFromHash(hash),
    section: sectionFromSearch(search) ?? sectionFromHash(hash),
  };
}

/**
 * 解析 href。curRepo / curFilePath = 目前 repo 與目前開啟檔(相對路徑基準)。
 * 回傳 null = 無法導航(空字串)。
 */
export function resolveLink(href: string, curRepo: string, curFilePath: string): LinkTarget | null {
  const raw = href.trim();
  if (!raw) return null;

  // 純錨點 → 同檔:#tab 切 tab;#其他 視為章節錨點(捲動到該標題)。
  if (raw.startsWith('#')) {
    return {
      kind: 'internal',
      repo: curRepo,
      path: curFilePath,
      tab: tabFromHash(raw),
      section: sectionFromHash(raw),
    };
  }

  // 有協定
  const proto = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (proto) {
    const scheme = proto[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      try {
        const u = new URL(raw);
        if (u.host === location.host) return parseInternalPath(u.pathname, u.hash, u.search);
      } catch {
        /* 解析失敗 → 當外部 */
      }
    }
    return { kind: 'external', url: raw };
  }

  // 站內絕對路徑 /<repo>/<path>[?sec=…][#tab]
  if (raw.startsWith('/')) {
    const { path, search, hash } = splitUrl(raw);
    return parseInternalPath(path, hash, search);
  }

  // 相對路徑(含 ..)→ 以目前檔案所在目錄為基準,同 repo。
  // href 可能 percent-encoded(尤其中文檔名)→ 先解碼成 raw,避免送 api 後 server 多一層 %。
  const { path: rel, search, hash } = splitUrl(raw);
  const base = dirOf(curFilePath);
  const decoded = safeDecode(rel);
  const path = normalizePath(base ? `${base}/${decoded}` : decoded);
  return {
    kind: 'internal',
    repo: curRepo,
    path,
    tab: tabFromHash(hash),
    section: sectionFromSearch(search) ?? sectionFromHash(hash),
  };
}
