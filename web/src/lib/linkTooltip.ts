/**
 * linkTooltip — 選字加/改連結的共用浮動小工具(供 CM6 編輯器與 TableBlock cell 共用)。
 *
 * 手勢:選取文字後「右鍵」點選區 → 於滑鼠處浮出「🔗 連結」鈕(純 DOM,不引 Antd)→
 *   點它派 `porthole:edit-link` 事件 → 由 MarkdownEditor 的 Modal 接手開 dialog。
 *
 * detail 帶 `apply(md)` callback,把來源(CM6 dispatch / cell 字串改寫)與 dialog UI 解耦:
 *   - CM6:apply = 以 [text](url) 取代原範圍(view.dispatch)。
 *   - table cell:apply = 把選取子字串換成 [text](url)(onChange 回寫本地 model)。
 * detail 於「右鍵當下」就建好(選取範圍已知),故之後失焦 / 選取消失都不影響套用。
 */
export interface LinkEditDetail {
  /** 連結文字(選取字串;若選取已是 [t](u) 則為 t)。 */
  text: string;
  /** 現有 href(新連結為空;既有連結則預填)。 */
  url: string;
  /** 套用:收 dialog 產生的 `[text](url)`,寫回來源。 */
  apply: (markdown: string) => void;
}

let tip: HTMLDivElement | null = null;

function onDocMouseDown(e: MouseEvent) {
  if (tip && !tip.contains(e.target as Node)) closeLinkTip();
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeLinkTip();
}

export function closeLinkTip(): void {
  if (tip) {
    tip.remove();
    tip = null;
  }
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeyDown);
}

/** 於 (x,y) 附近浮出連結鈕(label 預設「🔗 連結」,編輯既有連結可傳「🔗 編輯連結」);點擊 → 派 porthole:edit-link。 */
export function showLinkTip(x: number, y: number, detail: LinkEditDetail, label = '🔗 連結'): void {
  closeLinkTip();
  const el = document.createElement('div');
  el.setAttribute('data-loc', 'explore:edit:linktip');
  el.style.cssText =
    'position:fixed;z-index:1500;background:#fff;border:1px solid #d9d9d9;border-radius:6px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.15);padding:2px;';
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText =
    'border:none;background:transparent;cursor:pointer;font-size:13px;padding:4px 10px;' +
    'border-radius:4px;white-space:nowrap;color:#1677ff;';
  btn.onmouseenter = () => (btn.style.background = '#f0f7ff');
  btn.onmouseleave = () => (btn.style.background = 'transparent');
  // mousedown + preventDefault:不搶焦點(雖然 detail 已備妥,仍避免無謂閃動)。
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent<LinkEditDetail>('porthole:edit-link', { detail }));
    closeLinkTip();
  });
  el.appendChild(btn);
  document.body.appendChild(el);
  // 夾在視窗內(超出右/下邊 → 往左/上)。
  const rect = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  tip = el;
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeyDown);
}

/** 若選取字串本身是 [text](url) → 拆出 text/url(供既有連結預填);否則回 null。 */
export function parseInlineLink(s: string): { text: string; url: string } | null {
  const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(s.trim());
  return m ? { text: m[1], url: m[2] } : null;
}
