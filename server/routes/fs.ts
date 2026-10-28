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
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { guard } from '../lib/path-guard.ts';

const MAX_FILE = 2 * 1024 * 1024; // 2MB 上限,避免讀爆

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
  // 媒體:預覽區用 <audio> / <video> / <iframe> 直接吃 raw(支援 Range 才能拖進度條)
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};

/**
 * `Range: bytes=a-b` → [start, end](含)。不支援 / 超出 → null(呼叫端回 416)。
 * 只處理單一區段;`bytes=-500`(尾端 500)與 `bytes=500-`(到尾)都吃。
 */
function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : null;
}

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
      const buf = await fs.readFile(target);
      // 二進位(前 8KB 有 NUL)不當文字回 —— 前端改顯示「無法預覽 + 下載」,不是一坨亂碼。
      if (buf.subarray(0, 8192).includes(0)) {
        return reply.code(415).send({ error: 'binary file' });
      }
      const content = buf.toString('utf8');
      const ext = path.extname(target).toLowerCase();
      const markdown = ext === '.md' || ext === '.markdown';
      return { content, markdown, ext };
    },
  );

  // 原始位元組(圖片 <img>、<audio> / <video>、PDF、下載)。path-guard;依副檔名給 content-type。
  // **串流 + Range**:不整檔讀進記憶體,所以不設大小上限(33MB 的 wav 也照下);
  // <audio> / <video> 拖進度條靠 Range(206)。
  app.get<{ Params: { repo: string }; Querystring: { path?: string; download?: string } }>(
    '/api/:repo/raw',
    async (req, reply) => {
      const target = guard.resolveInRepo(req.params.repo, req.query.path ?? '');
      const st = await fs.stat(target);
      if (st.isDirectory()) return reply.code(400).send({ error: 'is a directory' });
      reply.header('content-type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
      reply.header('cache-control', 'no-cache');
      reply.header('accept-ranges', 'bytes');
      // ?download=1 → 強制下載(attachment)+ 帶檔名(RFC5987,支援中文);否則 inline(預覽)。
      if (req.query.download === '1' || req.query.download === 'true') {
        const fname = path.basename(target);
        reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      }
      const range = req.headers.range;
      if (range) {
        const r = parseRange(range, st.size);
        if (!r) {
          reply.header('content-range', `bytes */${st.size}`);
          return reply.code(416).send();
        }
        const [start, end] = r;
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${end}/${st.size}`);
        reply.header('content-length', end - start + 1);
        return reply.send(createReadStream(target, { start, end }));
      }
      reply.header('content-length', st.size);
      return reply.send(createReadStream(target));
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
