/**
 * session route — Session tab。
 * GET    /api/:repo/sessions            列 repo 可恢復的 claude session
 * POST   /api/:repo/sessions/:id/start  建/接 tmux 背景跑 claude --resume <id>
 * GET    /api/tmux                       列 porthole 的 tmux session
 * DELETE /api/tmux/:name                 收掉某 tmux session
 * WS     /ws/tmux/:name                  attach 進 tmux(xterm.js),斷線 = detach
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { guard } from '../lib/path-guard.ts';
import {
  listClaudeSessions,
  ensureTmux,
  listTmux,
  killTmux,
  tmuxName,
  tmuxExists,
} from '../lib/tmux.ts';
import { bridgePty } from '../lib/pty-bridge.ts';

function assertPortholeName(name: string): void {
  if (!/^porthole_[A-Za-z0-9_]+$/.test(name)) {
    throw Object.assign(new Error('invalid tmux name'), { statusCode: 400 });
  }
}

export default async function sessionRoutes(app: FastifyInstance) {
  app.get<{ Params: { repo: string } }>('/api/:repo/sessions', async (req) => {
    const root = guard.repoRoot(req.params.repo);
    const sessions = await listClaudeSessions(root);
    return { sessions };
  });

  app.post<{ Params: { repo: string; id: string } }>(
    '/api/:repo/sessions/:id/start',
    async (req) => {
      const root = guard.repoRoot(req.params.repo);
      const name = tmuxName(req.params.repo, req.params.id);
      await ensureTmux(name, root, req.params.id);
      return { name };
    },
  );

  app.get('/api/tmux', async () => {
    return { sessions: await listTmux() };
  });

  app.delete<{ Params: { name: string } }>('/api/tmux/:name', async (req, reply) => {
    assertPortholeName(req.params.name);
    try {
      await killTmux(req.params.name);
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: 'no such session' });
    }
  });

  app.get<{ Params: { name: string } }>(
    '/ws/tmux/:name',
    { websocket: true },
    async (socket: WebSocket, req) => {
      const name = req.params.name;
      try {
        assertPortholeName(name);
      } catch {
        socket.send('\r\n[error] invalid session name\r\n');
        socket.close();
        return;
      }
      if (!(await tmuxExists(name))) {
        socket.send(`\r\n[error] tmux session not found: ${name}\r\n`);
        socket.close();
        return;
      }
      // attach 進既有 tmux session;WS 關閉 → tmux client 退出 = detach,session 續跑。
      bridgePty(socket, { file: 'tmux', args: ['attach', '-t', name], cwd: guard.base });
    },
  );
}
