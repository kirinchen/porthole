/**
 * Terminal — xterm.js 接一個 WebSocket(CLI 與 Session 共用)。
 * 協定見 server/lib/pty-bridge.ts:client 送 JSON 控制訊息,server 送純文字輸出。
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from './api';

interface Props {
  /** WS path,如 /ws/cli/coral。null = 不連線(顯示空終端)。 */
  path: string | null;
  /** path 變動時用來強制重建。 */
  sessionKey?: string;
}

export default function Terminal({ path, sessionKey }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!path || !hostRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const ws = new WebSocket(wsUrl(path));
    const sendResize = () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => sendResize();
    ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : '');
    ws.onclose = () => term.write('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');

    term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }));
    });

    const onResize = () => {
      fit.fit();
      sendResize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      ws.close();
      term.dispose();
    };
  }, [path, sessionKey]);

  return <div ref={hostRef} style={{ height: '100%', width: '100%' }} />;
}
