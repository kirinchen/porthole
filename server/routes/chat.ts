/**
 * chat route — Chat tab。
 * POST /api/:repo/chat                  body {thread, prompt} → SSE 串流 claude -p
 * GET  /api/:repo/chat/threads          列 <repo>/doc/chat/*.md
 * GET  /api/:repo/chat/threads/:thread  讀某 thread
 *
 * 寫入面收斂(SPEC §2):Chat 只寫 <repo>/doc/chat/,經 path-guard。
 * 紀錄格式:human / assistant 輪流 append markdown。
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { guard } from '../lib/path-guard.ts';
import { runClaude } from '../lib/claude-p.ts';

const CHAT_DIR = 'doc/chat';

/** thread 名收斂成安全檔名(再交 path-guard 二次把關)。 */
function safeThread(name: string): string {
  const s = String(name).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
  return s || 'default';
}

function nowIso(): string {
  return new Date().toISOString();
}

export default async function chatRoutes(app: FastifyInstance) {
  app.get<{ Params: { repo: string } }>('/api/:repo/chat/threads', async (req) => {
    const repoRoot = guard.repoRoot(req.params.repo);
    const dir = path.join(repoRoot, CHAT_DIR);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { threads: [] };
    }
    const threads = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const st = await fs.stat(path.join(dir, n));
      threads.push({ name: n.slice(0, -3), mtime: st.mtimeMs });
    }
    threads.sort((a, b) => b.mtime - a.mtime);
    return { threads };
  });

  app.get<{ Params: { repo: string; thread: string } }>(
    '/api/:repo/chat/threads/:thread',
    async (req, reply) => {
      const rel = `${CHAT_DIR}/${safeThread(req.params.thread)}.md`;
      const target = guard.resolveInRepo(req.params.repo, rel);
      try {
        const content = await fs.readFile(target, 'utf8');
        return { content };
      } catch {
        return reply.code(404).send({ error: 'thread not found' });
      }
    },
  );

  app.post<{ Params: { repo: string }; Body: { thread?: string; prompt?: string } }>(
    '/api/:repo/chat',
    async (req, reply) => {
      const repo = req.params.repo;
      const prompt = (req.body?.prompt ?? '').trim();
      const thread = safeThread(req.body?.thread ?? 'default');
      if (!prompt) return reply.code(400).send({ error: 'empty prompt' });

      const cwd = guard.repoRoot(repo); // CWD = repo root
      const rel = `${CHAT_DIR}/${thread}.md`;
      const file = guard.resolveInRepo(repo, rel); // 寫入面:只允許 doc/chat/
      await fs.mkdir(path.dirname(file), { recursive: true });

      // 先寫 human turn
      await fs.appendFile(file, `\n## 🧑 Human · ${nowIso()}\n\n${prompt}\n`);

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let assistant = '';
      const run = runClaude(prompt, cwd);

      // client 中斷 → kill 子程序
      req.raw.on('close', () => run.abort());

      run.onChunk((text) => {
        assistant += text;
        send('delta', { text });
      });
      run.onError((text) => send('stderr', { text }));

      await new Promise<void>((resolve) => {
        run.onEnd(async (code) => {
          try {
            await fs.appendFile(file, `\n## 🤖 Assistant · ${nowIso()}\n\n${assistant}\n`);
          } catch {
            /* 寫檔失敗不阻斷回應 */
          }
          send('done', { code });
          reply.raw.end();
          resolve();
        });
      });
      return reply;
    },
  );
}
