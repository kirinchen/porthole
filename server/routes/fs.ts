/**
 * fs route — Explore tab(唯讀)。
 * GET /api/repos                     列 basePath 下的 repo
 * GET /api/:repo/tree?path=<rel>     列某目錄的子項(lazy,一層)
 * GET /api/:repo/file?path=<rel>     讀檔(回傳內容 + 是否 markdown)
 * PUT /api/:repo/file                寫檔(body {path, content};可覆寫既存或新增)
 * 全部經 path-guard;逃逸 → 403。寫入面鎖在 active repo root 內(SPEC §2)。
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { guard } from '../lib/path-guard.ts';

const MAX_FILE = 2 * 1024 * 1024; // 2MB 上限,避免讀爆
const MAX_RAW = 25 * 1024 * 1024; // raw 串流上限(圖片等)

// 原始串流的 content-type(主要給圖片);其餘 application/octet-stream。
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

interface Entry {
  name: string;
  path: string; // 相對 repo root
  type: 'dir' | 'file';
  mtime?: number; // 修改時間(ms);僅 ?stat=1 時附上
  size?: number; // 檔案大小(bytes);dir 省略,僅 ?stat=1 時附上
}

// 預設略過的雜訊目錄
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.vite']);

// 內容搜尋上限(避免大 repo 掃爆 / 回應過大)
const SEARCH_MAX_MATCHES = 2000; // 命中總數上限,達到即截斷
const SEARCH_MAX_FILE = 2 * 1024 * 1024; // 單檔 > 2MB 不掃
const SEARCH_SNIPPET = 300; // 回傳每行片段最長字元數
const BINARY_SNIFF = 8000; // 判斷 binary:前 N bytes 出現 NUL → 視為二進位跳過

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SearchMatch {
  line: number; // 1-based
  col: number; // 命中在(可能截斷的)片段內的起始 index
  len: number; // 命中長度
  text: string; // 該行片段(過長則以命中為中心開窗,前綴 …)
}
interface SearchFile {
  path: string; // 相對 repo root
  matches: SearchMatch[];
}

// 遞迴掃某目錄下所有檔,對每檔逐行比對 re;命中收進 out。達 SEARCH_MAX_MATCHES 即停(truncated)。
async function searchDir(
  dir: string,
  repoRoot: string,
  re: RegExp,
  out: SearchFile[],
  state: { count: number; truncated: boolean },
): Promise<void> {
  if (state.truncated) return;
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const d of dirents) {
    if (state.truncated) return;
    if (SKIP.has(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      await searchDir(full, repoRoot, re, out, state);
      continue;
    }
    if (!d.isFile()) continue;
    let buf: Buffer;
    try {
      const st = await fs.stat(full);
      if (st.size > SEARCH_MAX_FILE) continue;
      buf = await fs.readFile(full);
    } catch {
      continue; // broken symlink / 讀取失敗 → 跳過
    }
    if (buf.subarray(0, BINARY_SNIFF).includes(0)) continue; // binary
    const lines = buf.toString('utf8').split(/\r?\n/);
    const fileMatches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      let text = lines[i];
      let col = m.index;
      if (text.length > SEARCH_SNIPPET) {
        const start = Math.max(0, col - 40);
        text = (start > 0 ? '…' : '') + text.slice(start, start + SEARCH_SNIPPET);
        col = (start > 0 ? 1 : 0) + (col - start);
      }
      fileMatches.push({ line: i + 1, col, len: m[0].length, text });
      state.count++;
      if (state.count >= SEARCH_MAX_MATCHES) {
        state.truncated = true;
        break;
      }
    }
    if (fileMatches.length) {
      out.push({ path: path.relative(repoRoot, full), matches: fileMatches });
    }
  }
}

export default async function fsRoutes(app: FastifyInstance) {
  app.get('/api/repos', async () => {
    const entries = await fs.readdir(guard.base, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    return { base: guard.base, repos };
  });

  app.get<{ Params: { repo: string }; Querystring: { path?: string; stat?: string } }>(
    '/api/:repo/tree',
    async (req) => {
      const root = guard.resolveInRepo(req.params.repo, req.query.path ?? '.');
      const dirents = await fs.readdir(root, { withFileTypes: true });
      const repoRoot = guard.repoRoot(req.params.repo);
      // stat opt-in:資料夾視圖 list 模式要 mtime/size;左側 tree 不帶,免每筆 stat 拖慢。
      const withStat = req.query.stat === '1' || req.query.stat === 'true';
      const kept = dirents.filter((d) => !SKIP.has(d.name));
      const items: Entry[] = await Promise.all(
        kept.map(async (d) => {
          const isDir = d.isDirectory();
          const e: Entry = {
            name: d.name,
            path: path.relative(repoRoot, path.join(root, d.name)),
            type: isDir ? ('dir' as const) : ('file' as const),
          };
          if (withStat) {
            try {
              const st = await fs.stat(path.join(root, d.name));
              e.mtime = st.mtimeMs;
              if (!isDir) e.size = st.size;
            } catch {
              /* stat 失敗(broken symlink 等)→ 略過 meta,不擋清單 */
            }
          }
          return e;
        }),
      );
      items.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
      return { items };
    },
  );

  // 跨檔內容搜尋(find in files;Eclipse Ctrl+H 式)。path-guard 鎖在 repo root 內,
  // 跳 SKIP 目錄 / 大檔 / binary;regex 可選、預設不分大小寫;命中依檔分組,達上限截斷。
  app.get<{
    Params: { repo: string };
    Querystring: { q?: string; regex?: string; case?: string };
  }>('/api/:repo/search', async (req, reply) => {
    const q = req.query.q ?? '';
    if (!q) return { results: [], truncated: false };
    const isRegex = req.query.regex === '1' || req.query.regex === 'true';
    const caseSensitive = req.query.case === '1' || req.query.case === 'true';
    let re: RegExp;
    try {
      re = new RegExp(isRegex ? q : escapeRegExp(q), 'g' + (caseSensitive ? '' : 'i'));
    } catch {
      return reply.code(400).send({ error: 'invalid regex' });
    }
    const repoRoot = guard.repoRoot(req.params.repo);
    const out: SearchFile[] = [];
    const state = { count: 0, truncated: false };
    await searchDir(repoRoot, repoRoot, re, out, state);
    return { results: out, truncated: state.truncated };
  });

  app.get<{ Params: { repo: string }; Querystring: { path?: string } }>(
    '/api/:repo/file',
    async (req, reply) => {
      const target = guard.resolveInRepo(req.params.repo, req.query.path ?? '');
      const st = await fs.stat(target);
      if (st.isDirectory()) {
        return reply.code(400).send({ error: 'is a directory' });
      }
      if (st.size > MAX_FILE) {
        return reply.code(413).send({ error: 'file too large' });
      }
      const content = await fs.readFile(target, 'utf8');
      const ext = path.extname(target).toLowerCase();
      const markdown = ext === '.md' || ext === '.markdown';
      return { content, markdown, ext };
    },
  );

  // 原始位元組串流(圖片預覽用 <img src>)。path-guard;依副檔名給 content-type。
  app.get<{ Params: { repo: string }; Querystring: { path?: string; download?: string } }>(
    '/api/:repo/raw',
    async (req, reply) => {
      const target = guard.resolveInRepo(req.params.repo, req.query.path ?? '');
      const st = await fs.stat(target);
      if (st.isDirectory()) return reply.code(400).send({ error: 'is a directory' });
      if (st.size > MAX_RAW) return reply.code(413).send({ error: 'file too large' });
      const buf = await fs.readFile(target);
      reply.header('content-type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
      reply.header('cache-control', 'no-cache');
      // ?download=1 → 強制下載(attachment)+ 帶檔名(RFC5987,支援中文);否則 inline(圖片預覽)。
      if (req.query.download === '1' || req.query.download === 'true') {
        const fname = path.basename(target);
        reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      }
      return reply.send(buf);
    },
  );

  // 寫檔:path-guard 鎖在 repo root 內;可覆寫既存或新增(含建中間目錄)。
  // encoding=base64 → 寫二進位(上傳檔用);否則當 utf8 文字。
  app.put<{
    Params: { repo: string };
    Body: { path?: string; content?: string; encoding?: 'utf8' | 'base64' };
  }>(
    '/api/:repo/file',
    { bodyLimit: 8 * 1024 * 1024 }, // base64 膨脹 ~33% → 放寬,實際大小以解碼後 MAX_FILE 為準
    async (req, reply) => {
      const rel = req.body?.path ?? '';
      const content = req.body?.content ?? '';
      const encoding = req.body?.encoding === 'base64' ? 'base64' : 'utf8';
      if (!rel) return reply.code(400).send({ error: 'path required' });
      const buf = Buffer.from(content, encoding);
      if (buf.byteLength > MAX_FILE) {
        return reply.code(413).send({ error: 'content too large' });
      }
      const target = guard.resolveInRepo(req.params.repo, rel);
      try {
        const st = await fs.stat(target);
        if (st.isDirectory()) return reply.code(400).send({ error: 'is a directory' });
      } catch {
        /* 不存在 → 新檔,允許 */
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf);
      return { ok: true };
    },
  );

  // 新增目錄:path-guard 鎖在 repo root 內;recursive(含中間目錄)。
  app.post<{ Params: { repo: string }; Body: { path?: string } }>(
    '/api/:repo/dir',
    async (req, reply) => {
      const rel = req.body?.path ?? '';
      if (!rel) return reply.code(400).send({ error: 'path required' });
      const target = guard.resolveInRepo(req.params.repo, rel);
      await fs.mkdir(target, { recursive: true });
      return { ok: true };
    },
  );

  // 刪除檔 / 目錄(目錄連內容)。path-guard;不可刪 repo root。
  app.delete<{ Params: { repo: string }; Querystring: { path?: string } }>(
    '/api/:repo/fs',
    async (req, reply) => {
      const rel = req.query.path ?? '';
      if (!rel) return reply.code(400).send({ error: 'path required' });
      const target = guard.resolveInRepo(req.params.repo, rel);
      if (target === guard.repoRoot(req.params.repo)) {
        return reply.code(400).send({ error: 'cannot delete repo root' });
      }
      await fs.rm(target, { recursive: true, force: false });
      return { ok: true };
    },
  );

  // 改名 / 移動(repo 內)。path-guard 鎖兩端;拒覆蓋既存、拒動 repo root。
  app.post<{ Params: { repo: string }; Body: { from?: string; to?: string } }>(
    '/api/:repo/rename',
    async (req, reply) => {
      const from = req.body?.from ?? '';
      const to = req.body?.to ?? '';
      if (!from || !to) return reply.code(400).send({ error: 'from and to required' });
      const src = guard.resolveInRepo(req.params.repo, from);
      const dst = guard.resolveInRepo(req.params.repo, to);
      if (src === guard.repoRoot(req.params.repo)) {
        return reply.code(400).send({ error: 'cannot rename repo root' });
      }
      try {
        await fs.access(dst);
        return reply.code(409).send({ error: 'target exists' });
      } catch {
        /* 不存在 → 可改 */
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      return { ok: true };
    },
  );
}
