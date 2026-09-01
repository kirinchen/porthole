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

/**
 * execCommand('copy') fallback:攔 `copy` 事件用 `clipboardData.setData` 直接塞文字,
 * 不依賴「哪個元素被選取 / 聚焦」。因為在 antd Modal 內,focus trap 會搶焦點、且聚焦的 input
 * 會讓 execCommand 複製到該 input 的(空)選取 → 直接複製會失敗;改在 copy 事件覆寫資料就免疫。
 * 需有選取 execCommand('copy') 才會觸發 copy 事件,故以隱藏 span + Range 保證觸發(用後還原)。
 */
function fallbackCopy(text: string): boolean {
  let ok = false;
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    ok = true;
  };
  document.addEventListener('copy', onCopy, true);
  const span = document.createElement('span');
  span.textContent = text;
  span.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;user-select:text;white-space:pre;';
  document.body.appendChild(span);
  const sel = window.getSelection();
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('copy');
  } catch {
    /* ok 由 onCopy 決定 */
  } finally {
    sel?.removeAllRanges();
    if (prev) sel?.addRange(prev);
    span.remove();
    document.removeEventListener('copy', onCopy, true);
  }
  return ok;
}
