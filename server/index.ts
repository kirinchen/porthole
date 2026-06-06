/**
 * porthole 後端入口 — Fastify,單 port 4321,只綁 127.0.0.1(SPEC §2)。
 * serve 前端 build + REST/SSE + WebSocket;PathGuardError → 403。
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PathGuardError, guard } from './lib/path-guard.ts';
import fsRoutes from './routes/fs.ts';
import chatRoutes from './routes/chat.ts';
import sessionRoutes from './routes/session.ts';
import cliRoutes from './routes/cli.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../web/dist');
const PORT = Number(process.env.PORT ?? 4321);
const HOST = '127.0.0.1';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// PathGuardError → 403
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof PathGuardError) {
    return reply.code(403).send({ error: err.message });
  }
  const status = err.statusCode ?? 500;
  app.log.error(err);
  return reply.code(status).send({ error: err.message });
});

await app.register(fastifyWebsocket);

// 路由
await app.register(fsRoutes);
await app.register(chatRoutes);
await app.register(sessionRoutes);
await app.register(cliRoutes);

// prod:serve 前端 build + SPA fallback。dev 時 web/dist 不存在 → 略過,前端走 vite。
if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) => {
    // API/WS 走原本 404;其餘(SPA route 如 /coral)回 index.html
    if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`web/dist 不存在(${WEB_DIST});dev 模式請用 vite。`);
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`porthole on http://${HOST}:${PORT}  basePath=${guard.base}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
