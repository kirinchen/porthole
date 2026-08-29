/**
 * clipboard — 複製文字到剪貼簿,含非安全內容(http 非 localhost)fallback。
 *
 * `navigator.clipboard` 僅在安全內容(https / localhost)存在;porthole 常經
 * `http://<tailscale-ip>:4321` 存取 → clipboard 為 undefined。此時退回舊版
 * `document.execCommand('copy')`(需在 user gesture 內同步執行,故不 await)。
 */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text), // 安全內容但被拒 → 仍試 execCommand
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

/** execCommand('copy') fallback:隱藏 textarea 選取後複製。回傳是否成功。 */
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
