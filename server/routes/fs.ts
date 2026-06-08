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

interface Entry {
  name: string;
  path: string; // 相對 repo root
  type: 'dir' | 'file';
}

// 預設略過的雜訊目錄
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.vite']);

export default async function fsRoutes(app: FastifyInstance) {
  app.get('/api/repos', async () => {
    const entries = await fs.readdir(guard.base, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    return { base: guard.base, repos };
  });

  app.get<{ Params: { repo: string }; Querystring: { path?: string } }>(
    '/api/:repo/tree',
    async (req) => {
      const root = guard.resolveInRepo(req.params.repo, req.query.path ?? '.');
      const dirents = await fs.readdir(root, { withFileTypes: true });
      const repoRoot = guard.repoRoot(req.params.repo);
      const items: Entry[] = dirents
        .filter((d) => !SKIP.has(d.name))
        .map((d) => ({
          name: d.name,
          path: path.relative(repoRoot, path.join(root, d.name)),
          type: d.isDirectory() ? ('dir' as const) : ('file' as const),
        }))
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
        );
      return { items };
    },
  );

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

  // 寫檔:path-guard 鎖在 repo root 內;可覆寫既存或新增(含建中間目錄)。
  app.put<{ Params: { repo: string }; Body: { path?: string; content?: string } }>(
    '/api/:repo/file',
    { bodyLimit: 4 * 1024 * 1024 }, // 容納 2MB 檔 + JSON 包裝
    async (req, reply) => {
      const rel = req.body?.path ?? '';
      const content = req.body?.content ?? '';
      if (!rel) return reply.code(400).send({ error: 'path required' });
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE) {
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
      await fs.writeFile(target, content, 'utf8');
      return { ok: true };
    },
  );
}
