/**
 * Terminal — xterm.js 接一個 WebSocket(CLI 與 Session 共用)。
 * 協定見 server/lib/pty-bridge.ts:client 送 JSON 控制訊息,server 送純文字輸出。
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from './api';
import { installOsc52 } from './osc52';

interface Props {
  /** WS path,如 /ws/cli/coral。null = 不連線(顯示空終端)。 */
  path: string | null;
  /** path 變動時用來強制重建。 */
  sessionKey?: string;
  /** true 時接收 ContentPick 的 `porthole:mention`,以 bracketed paste 貼進終端。 */
  acceptMention?: boolean;
}

export default function Terminal({ path, sessionKey, acceptMention }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef(false);
  useEffect(() => {
    acceptRef.current = !!acceptMention;
  }, [acceptMention]);

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
    const osc52 = installOsc52(term); // 遠端 OSC 52 → 本機剪貼簿

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

    let raf = 0;
    // ContentPick 引用 → 以 bracketed paste 貼進(不自動送出,讓使用者檢視/編輯後再送)。
    const onMention = (e: Event) => {
      if (!acceptRef.current || ws.readyState !== ws.OPEN) return;
      const { text, source } = (e as CustomEvent<{ text: string; source?: string }>).detail || {};
      if (!text) return;
      const payload = (source ? `[${source}]\n` : '') + text;
      ws.send(JSON.stringify({ type: 'data', data: `\x1b[200~${payload}\x1b[201~` }));
    };
    window.addEventListener('porthole:mention', onMention);

    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fit.fit(); // 容器 0 尺寸時 FitAddon 自動略過,安全
        sendResize();
      });
    };
    window.addEventListener('resize', onResize);
    // 容器尺寸變化也要 refit:保活顯隱(display none→block)、Splitter 拖動、
    // 右側面板收合,window resize 都不會觸發,靠 ResizeObserver 補。
    const ro = new ResizeObserver(onResize);
    ro.observe(hostRef.current);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('porthole:mention', onMention);
      ro.disconnect();
      osc52.dispose();
      ws.close();
      term.dispose();
    };
  }, [path, sessionKey]);

  return <div ref={hostRef} style={{ height: '100%', width: '100%' }} />;
}
