/**
 * pty-bridge — 把一個 node-pty 進程接到一個 WebSocket。
 * CLI 與 Session(tmux attach)共用。
 *
 * 協定:
 *  - client → server:JSON 控制訊息
 *      {type:'data', data:string}      鍵盤輸入
 *      {type:'resize', cols, rows}     視窗大小
 *  - server → client:純文字 frame = pty 輸出
 */
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { WebSocket } from 'ws';

export interface PtyOpts {
  file: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

export function bridgePty(socket: WebSocket, opts: PtyOpts): IPty {
  const term: IPty = ptySpawn(opts.file, opts.args, {
    name: 'xterm-color',
    cwd: opts.cwd,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    env: process.env as Record<string, string>,
  });

  term.onData((d: string) => {
    if (socket.readyState === socket.OPEN) socket.send(d);
  });
  term.onExit(() => {
    if (socket.readyState === socket.OPEN) socket.close();
  });

  socket.on('message', (raw: Buffer | string) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 非 JSON 控制訊息一律忽略
    }
    if (msg.type === 'data' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        term.resize(msg.cols, msg.rows);
      } catch {
        /* resize 失敗忽略 */
      }
    }
  });

  socket.on('close', () => term.kill());
  return term;
}
