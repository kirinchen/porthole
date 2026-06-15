/**
 * OSC 52 — 把遠端(tmux / claude 等)emit 的剪貼簿序列轉寫到本機剪貼簿。
 * 參考 piermux/src/lib/osc52.ts;差別:porthole 是 web,改用瀏覽器剪貼簿
 * (navigator.clipboard;非安全上下文 http 區網 → execCommand fallback)。
 *
 * OSC 52 payload:`<selection>;<base64 | ?>`。`?` 是「查詢本機剪貼簿」→ 一律拒絕
 * (安全:絕不把本機剪貼簿回傳給遠端)。
 */
import type { Terminal, IDisposable } from '@xterm/xterm';

/** 寫剪貼簿,含非安全上下文 fallback(同 DevPick)。 */
function copyText(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* 連 fallback 都失敗就算了 */
  }
  document.body.removeChild(ta);
}

export function installOsc52(term: Terminal): IDisposable {
  return term.parser.registerOscHandler(52, (data: string) => {
    const m = data.match(/^([cps0-7]*);(.+)$/);
    if (!m) return false;
    const payload = m[2];
    if (payload === '?') return true; // 拒絕讀取查詢

    try {
      // base64 → bytes → UTF-8(atob 只還原成 Latin-1,中文等多 byte 要再 decode)。
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      copyText(new TextDecoder().decode(bytes));
    } catch {
      return false;
    }
    return true;
  });
}
