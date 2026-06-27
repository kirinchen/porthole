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
import { existsSync } from 'node:fs';
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

/** claude 產出的主題 → kebab-case slug(只留小寫英數 + 連字號)。 */
function slugify(raw: string): string {
  const line = raw.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** 用 claude -p 分析對話開頭,產生英文 kebab-case 主題 slug。 */
function genTitle(content: string, cwd: string): Promise<string> {
  const excerpt = content.slice(0, 1500);
  const prompt =
    '根據下面這段對話的開頭,產生一個能代表主題的檔名 slug:' +
    '3-6 個英文單字、全小寫、用連字號連接(kebab-case),' +
    '只輸出 slug 本身,不要引號、說明或副檔名。\n\n' +
    excerpt;
  return new Promise((resolve) => {
    let out = '';
    const run = runClaude(prompt, cwd);
    run.onChunk((t) => (out += t));
    run.onEnd(() => resolve(out));
  });
}

// 上文 context 上限(避免超長 thread 把 prompt 撐爆;取尾端最近的對話)。
const MAX_CTX = 120 * 1024;

/**
 * 把該 thread 先前的紀錄(porthole 的 turn markdown)組成 context,接上最新訊息。
 * claude -p 是 stateless 的一次性呼叫,不帶上文就「沒記憶」→ 這裡把對話餵回去。
 */
function buildContextPrompt(priorRaw: string, latest: string): string {
  let prior = priorRaw.trim();
  if (!prior) return latest; // 新 thread:無上文
  if (prior.length > MAX_CTX) prior = prior.slice(-MAX_CTX); // 只留最近
  const transcript = prior
    .replace(/^\s*##\s*🧑\s*Human\s*·.*$/gm, '\n[使用者]')
    .replace(/^\s*##\s*🤖\s*Assistant\s*·.*$/gm, '\n[你先前的回覆]')
    .trim();
  return (
    '以下是我們先前的對話紀錄,請延續它、保持脈絡與記憶來回答(不要重複問已知資訊):\n\n' +
    '===== 對話紀錄(舊→新)=====\n' +
    transcript +
    '\n===== 紀錄結束 =====\n\n' +
    '[使用者最新訊息]\n' +
    latest
  );
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

  // thread 改名:body 給 {to} → 手動改名(safeThread 收斂);否則用 claude 分析主題自動命名。
  // 寫入面仍鎖 doc/chat/。
  app.post<{ Params: { repo: string; thread: string }; Body: { to?: string } }>(
    '/api/:repo/chat/threads/:thread/rename',
    async (req, reply) => {
      const repo = req.params.repo;
      const oldName = safeThread(req.params.thread);
      const oldFile = guard.resolveInRepo(repo, `${CHAT_DIR}/${oldName}.md`);
      let content: string;
      try {
        content = await fs.readFile(oldFile, 'utf8');
      } catch {
        return reply.code(404).send({ error: 'thread not found' });
      }

      const manual = (req.body?.to ?? '').trim();
      const base = manual ? safeThread(manual) : slugify(await genTitle(content, guard.repoRoot(repo)));
      if (!base) return { name: oldName }; // 給不出名字就維持原名

      // 命名衝突 → 加 -2/-3…;與原名相同則免改。
      let name = base;
      for (let i = 2; ; i++) {
        const candidate = safeThread(name);
        if (candidate === oldName) return { name: oldName };
        const target = guard.resolveInRepo(repo, `${CHAT_DIR}/${candidate}.md`);
        if (!existsSync(target)) {
          await fs.rename(oldFile, target);
          return { name: candidate };
        }
        name = `${base}-${i}`;
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

      // 取先前對話當 context(在寫入本輪 human turn「之前」讀,故是純粹的上文)。
      let priorRaw = '';
      try {
        priorRaw = await fs.readFile(file, 'utf8');
      } catch {
        /* 新 thread,無上文 */
      }

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
      // 帶上文:把先前對話 + 最新訊息一起給 claude -p(否則 stateless 沒記憶)。
      const run = runClaude(buildContextPrompt(priorRaw, prompt), cwd);

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
