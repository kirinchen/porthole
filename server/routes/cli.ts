/**
 * cli route — CLI tab。PTY shell over WebSocket,CWD = repo root(過 path-guard)。
 * WS /ws/cli/:repo
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { guard, PathGuardError } from '../lib/path-guard.ts';
import { bridgePty } from '../lib/pty-bridge.ts';
import { isSameOriginWs } from '../lib/ws-origin.ts';

export default async function cliRoutes(app: FastifyInstance) {
  app.get<{ Params: { repo: string } }>(
    '/ws/cli/:repo',
    { websocket: true },
    (socket: WebSocket, req) => {
      if (!isSameOriginWs(req)) {
        socket.send('\r\n[error] cross-origin websocket rejected\r\n');
        socket.close();
        return;
      }
      let cwd: string;
      try {
        cwd = guard.repoRoot(req.params.repo);
      } catch (e) {
        socket.send(
          e instanceof PathGuardError ? `\r\n[path guard] ${e.message}\r\n` : '\r\n[error]\r\n',
        );
        socket.close();
        return;
      }
      const shell = process.env.SHELL || '/bin/bash';
      bridgePty(socket, { file: shell, args: [], cwd });
    },
  );
}
