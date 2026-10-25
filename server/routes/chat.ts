/**
 * chat route — 對話。
 *  POST   /api/:repo/chat                   body {thread, prompt, link?, model?, effort?} → SSE 串流 claude -p
 *  GET    /api/:repo/chat/threads           列 <repo>/doc/chat/*.md(含 title / link)
 *  GET    /api/:repo/chat/threads/:thread   讀某 thread
 *  POST   /api/:repo/chat/threads/:t/rename body {to?} → 手動改名 / 自動命名
 *  GET    /api/:repo/chat/for-file?path=    某個檔的「預設對話」是哪一條(SPEC §4.2.1)
 *  GET    /api/:repo/chat/jobs/:thread      那輪還在跑嗎
 *  DELETE /api/:repo/chat/jobs/:thread      中斷那輪
 *  GET    /api/chat/engine                  可選的 model / effort(前端 ⚙ 用)
 *
 * 寫入面收斂(SPEC §2):Chat 只寫 <repo>/doc/chat/,經 path-guard。
 * 紀錄格式:檔首一行 H1 = **顯示標題**(可中文),綁檔的再加一行 link 註記,
 * 之後 human / assistant 輪流 append markdown。見 SPEC §9.3。
 *
 * 檔名 vs 標題:**檔名一律英文 kebab-case slug**(跨工具 / git / URL 都安全),
 * 想看的中文放在檔案第一行 `# 標題` —— 顯示名跟著檔案走(搬移 / clone / 在 Explore
 * 看都還在),不必另存一份 index 去 drift。
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { guard } from '../lib/path-guard.ts';
import { runClaude, MODELS, EFFORTS, type ClaudeRun } from '../lib/claude-p.ts';
import { safeThread, slugify, readH1, setH1, parseGenTitle } from '../lib/chat-title.ts';
import { readLink, setLink, linkSuffix, linkedThreadName, reslug, linkContext } from '../lib/chat-link.ts';

const CHAT_DIR = 'doc/chat';
/** 檔頭讀多少就夠拿到 title + link(列表可能幾十個檔,不為兩行把整檔讀進來)。 */
const HEAD_BYTES = 4096;

function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * job registry —— 「那輪還在跑嗎 / 停得掉嗎」
 *
 * SSE 連線隨 reload 斷掉,但後端那趟 claude -p 還在跑。只靠「檔尾是 Human turn」
 * 去猜(前端的 fallback)看不出是真的在跑還是當掉了,也沒辦法中斷。所以在記憶體
 * 記一份 in-flight 表:開 thread / 重整 / 另一台瀏覽器進來都問得到,也殺得掉。
 * 後端重啟 → 表隨記憶體消失(那支子程序也跟著死),前端退回檔案輪詢。
 * ------------------------------------------------------------------ */
interface Job {
  state: 'running';
  startedAt: number;
  model?: string;
  effort?: string;
  run: ClaudeRun;
}
const jobs = new Map<string, Job>();
const jobKey = (repo: string, thread: string) => `${repo}\u0000${thread}`;

/** 對外形狀(不把 run 這個 handle 洩出去)。 */
function jobView(j: Job | undefined) {
  if (!j) return null;
  return { state: j.state, startedAt: j.startedAt, model: j.model ?? null, effort: j.effort ?? null };
}

/**
 * 用 claude -p 分析對話開頭,一次要到兩樣:**中文顯示標題** + **英文 kebab-case slug**。
 * 一次呼叫拿兩個(而非兩次 claude -p)—— 省一趟子程序,且標題與 slug 出自同一次理解。
 * 回傳 `{ title, slug }`;解析不出 slug 時 slug 為空字串(呼叫端據此維持原檔名)。
 */
function genTitle(content: string, cwd: string): Promise<{ title: string; slug: string }> {
  const excerpt = content.slice(0, 1500);
  const prompt =
    '根據下面這段對話的開頭,輸出剛好兩行,不要任何其他文字:\n' +
    '第一行:能代表主題的**繁體中文**標題(10-20 字,不要引號、不要句號)。\n' +
    '第二行:對應的英文檔名 slug(3-6 個英文單字、全小寫、連字號連接 kebab-case,' +
    '不要引號或副檔名)。\n\n' +
    excerpt;
  return new Promise((resolve) => {
    let out = '';
    const run = runClaude(prompt, cwd);
    run.onChunk((t) => (out += t));
    run.onEnd(() => resolve(parseGenTitle(out)));
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

interface ThreadRow {
  name: string;
  mtime: number;
  title: string | null;
  link: string | null;
}

/** 讀每個 thread 的檔頭,取 title(H1)與 link 註記。讀不到 → 兩者皆 null。 */
async function listThreads(repoRoot: string): Promise<ThreadRow[]> {
  const dir = path.join(repoRoot, CHAT_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows: ThreadRow[] = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const file = path.join(dir, n);
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      continue; // 列完之後被刪掉
    }
    let title: string | null = null;
    let link: string | null = null;
    try {
      const fh = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString('utf8');
        title = readH1(head);
        link = readLink(head);
      } finally {
        await fh.close();
      }
    } catch {
      /* 讀不到檔頭 → 前端退回顯示檔名 */
    }
    rows.push({ name: n.slice(0, -3), mtime: st.mtimeMs, title, link });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/** repo 相對路徑正規化(擋 `..`;真正的邊界仍由 path-guard 把關)。 */
function relPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const rel = raw.replace(/\\/g, '/').replace(/^\.?\/+/, '').trim();
  if (!rel || rel.split('/').some((seg) => seg === '..')) return null;
  return rel;
}

export default async function chatRoutes(app: FastifyInstance) {
  // ⚙ 可選的 model / effort(白名單;前端只畫下拉,不自己編清單)。
  app.get('/api/chat/engine', async () => ({ engine: 'claude', models: MODELS, efforts: EFFORTS }));

  app.get<{ Params: { repo: string } }>('/api/:repo/chat/threads', async (req) => ({
    threads: await listThreads(guard.repoRoot(req.params.repo)),
  }));

  /**
   * 某個檔的「預設對話」是哪一條(SPEC §4.2.1)。
   * 以 link 註記為準(權威),註記缺了才退回檔名後綴;都沒有 → 回一個**還不存在**的建議名字
   * (前端照它開新對話,第一次送出才落檔)。
   * `?new=1`:不要找既有的,直接給一個沒被占用的新名字 —— 同一個檔要再開一條時用。
   */
  app.get<{ Params: { repo: string }; Querystring: { path?: string; new?: string } }>(
    '/api/:repo/chat/for-file',
    async (req, reply) => {
      const rel = relPath(req.query.path);
      if (!rel) return reply.code(400).send({ error: 'bad path' });
      const rows = await listThreads(guard.repoRoot(req.params.repo));
      const wantNew = req.query.new === '1';
      if (!wantNew) {
        const byLink = rows.find((r) => r.link === rel);
        if (byLink) return { name: byLink.name, title: byLink.title, exists: true };
        const suf = linkSuffix(rel);
        // 後綴對得上、且沒被別的檔占用(link 註記指到別處)才算是這個檔的
        const bySuffix = rows.find((r) => r.name.endsWith(suf) && (r.link === null || r.link === rel));
        if (bySuffix) return { name: bySuffix.name, title: bySuffix.title, exists: true };
      }
      // 給一個沒被占用的新名字(第一次送出才真的落檔)
      const taken = new Set(rows.map((r) => r.name));
      const base = linkedThreadName(rel);
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
      return { name, title: null, exists: false };
    },
  );

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

  app.get<{ Params: { repo: string; thread: string } }>(
    '/api/:repo/chat/jobs/:thread',
    async (req) => ({ job: jobView(jobs.get(jobKey(req.params.repo, safeThread(req.params.thread)))) }),
  );

  // 中斷:SIGTERM 那支 claude -p。已 append 的 turn 不回捲(SPEC §4.2)。
  app.delete<{ Params: { repo: string; thread: string } }>(
    '/api/:repo/chat/jobs/:thread',
    async (req, reply) => {
      const j = jobs.get(jobKey(req.params.repo, safeThread(req.params.thread)));
      if (!j) return reply.code(404).send({ error: 'no running job' });
      j.run.abort();
      return { ok: true };
    },
  );

  // thread 改名:body 給 {to} → 手動改名;否則用 claude 分析主題自動命名。寫入面仍鎖 doc/chat/。
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
      // 自動:claude 一次給中文標題 + 英文 slug。
      // 手動:使用者輸入即標題(可中文);檔名取 `slugify` 的結果(與自動命名同一套 kebab-case)
      // —— 中英混排如「3090 24G 價格走勢」會得到 `3090-24g`,而不是 `safeThread` 把中文逐字
      // 換成底線的 `3090_24G_____`。slug 為空(純中文)→ 檔名維持原樣,只改標題。
      const auto = manual ? null : await genTitle(content, guard.repoRoot(repo));
      const title = manual || auto?.title || '';
      const slug = manual ? slugify(manual) : (auto?.slug ?? '');

      // 標題寫進檔首 H1(先寫,檔名改不改都要有標題)。
      if (title) {
        const next = setH1(content, title);
        if (next !== content) {
          await fs.writeFile(oldFile, next, 'utf8');
          content = next;
        }
      }
      const done = () => ({ name: oldName, title: title || readH1(content), link: readLink(content) });
      if (!slug) return done(); // 只改標題,檔名不動

      // 綁檔的 thread:只換 `<slug>` 段,`-<file>-<hex12>` 後綴保持不動(SPEC §4.2.1)。
      const link = readLink(content);
      const base = (link && reslug(oldName, link, slug)) || slug;

      // 命名衝突 → 加 -2/-3…;與原名相同則免改。
      let name = base;
      for (let i = 2; ; i++) {
        const candidate = safeThread(name);
        if (candidate === oldName) return done();
        const target = guard.resolveInRepo(repo, `${CHAT_DIR}/${candidate}.md`);
        if (!existsSync(target)) {
          await fs.rename(oldFile, target);
          return { name: candidate, title: title || readH1(content), link };
        }
        name = `${base}-${i}`;
      }
    },
  );

  app.post<{
    Params: { repo: string };
    Body: { thread?: string; prompt?: string; link?: string; model?: string; effort?: string };
  }>('/api/:repo/chat', async (req, reply) => {
    const repo = req.params.repo;
    const prompt = (req.body?.prompt ?? '').trim();
    const thread = safeThread(req.body?.thread ?? 'default');
    if (!prompt) return reply.code(400).send({ error: 'empty prompt' });

    const key = jobKey(repo, thread);
    if (jobs.has(key)) return reply.code(409).send({ error: 'this thread already has a running job' });

    // model / effort 走白名單:argv 不經 shell 已擋掉注入,但也不該把任意字串當 flag 丟給 CLI。
    const model = MODELS.includes(req.body?.model as never) ? req.body?.model : undefined;
    const effort = EFFORTS.includes(req.body?.effort as never) ? req.body?.effort : undefined;
    // 綁檔對話:link = 那個檔的 repo 相對路徑(SPEC §4.2.1)。
    const link = relPath(req.body?.link);

    const cwd = guard.repoRoot(repo); // CWD = repo root
    const file = guard.resolveInRepo(repo, `${CHAT_DIR}/${thread}.md`); // 寫入面:只允許 doc/chat/
    await fs.mkdir(path.dirname(file), { recursive: true });

    // 取先前對話當 context(在寫入本輪 human turn「之前」讀,故是純粹的上文)。
    let priorRaw = '';
    try {
      priorRaw = await fs.readFile(file, 'utf8');
    } catch {
      /* 新 thread,無上文 */
    }

    // 綁檔的 thread:確保 link 註記在檔裡(第一次送出時寫進去;檔名只是給人看的)。
    if (link && readLink(priorRaw) !== link) {
      priorRaw = setLink(priorRaw, link);
      await fs.writeFile(file, priorRaw, 'utf8');
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
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client 已斷線 → 這輪照跑,回覆由下面的 appendFile 落檔 */
      }
    };

    let assistant = '';
    // 帶上文:把先前對話 + 最新訊息一起給 claude -p(否則 stateless 沒記憶)。
    // 綁檔的再前綴一段脈絡區塊(開著哪個檔 / 可以改它 / 要回報)。
    // yolo:讓 chat agent 能實際用工具(否則多數功能被權限提示卡住);CWD 受 path-guard。
    const body = buildContextPrompt(priorRaw, prompt);
    const full = link ? linkContext(repo, link) + body : body;
    const run = runClaude(full, cwd, { yolo: true, model, effort });
    jobs.set(key, { state: 'running', startedAt: Date.now(), model, effort, run });

    // **client 斷線不 kill 子程序**:關分頁 / 重整 / 切去別的 thread 都要讓這輪跑完並 append
    // 到檔案(SPEC §4.2「切走那輪不中斷」)。要停就明確打 DELETE /chat/jobs/:thread。
    // 斷線後 reply.raw.write 會失敗 → 吞掉,別讓它炸掉整個 handler(回覆仍會寫進檔案)。

    run.onChunk((text) => {
      assistant += text;
      send('delta', { text });
    });
    run.onError((text) => send('stderr', { text }));

    await new Promise<void>((resolve) => {
      run.onEnd(async (code) => {
        jobs.delete(key);
        try {
          await fs.appendFile(file, `\n## 🤖 Assistant · ${nowIso()}\n\n${assistant}\n`);
        } catch {
          /* 寫檔失敗不阻斷回應 */
        }
        send('done', { code });
        try {
          reply.raw.end();
        } catch {
          /* 已斷線 */
        }
        resolve();
      });
    });
    return reply;
  });
}
