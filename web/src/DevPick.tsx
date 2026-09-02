/**
 * DevPick — agent 友善的 UI 元素定位器(Ctrl+F12)。
 * 移植 doc/Wiki/guides/dev-pick-locator.md。掛 App 根層。
 *
 *  - Ctrl+F12 開/關 pick 模式(頂部橫條提示)
 *  - hover 高亮游標下元素;click 算混合定位器 → 複製 + 角落 toast → 自動退出
 *  - Esc 退出
 *  - 剪貼簿:走共用 lib/clipboard.copyText(非安全上下文 fallback 用 copy 事件攔截,
 *    對 antd Modal 的 focus trap 免疫 —— 舊 textarea+focus 法在對話框內會複製到空字串)
 */
import { useEffect, useRef, useState } from 'react';
import { copyText } from './lib/clipboard';

/** 短 CSS path:往上最多 5 層,遇 id / data-loc 即停。 */
function cssPath(start: Element): string {
  const parts: string[] = [];
  let node: Element | null = start;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    if (node.id) {
      parts.unshift('#' + node.id);
      break;
    }
    const dl = node.getAttribute('data-loc');
    if (dl) {
      parts.unshift(`[data-loc="${dl}"]`);
      break;
    }
    let sel = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    const sibs = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
    if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    parts.unshift(sel);
    node = parent;
    depth++;
  }
  return parts.join(' > ');
}

/** 混合定位器。 */
function buildLoc(el: Element): string {
  const route = location.pathname;
  const dl = el.closest('[data-loc]')?.getAttribute('data-loc');
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  return [
    `route=${route}`,
    dl && `data-loc=${dl}`,
    text && `text="${text}"`,
    `tag=${el.tagName.toLowerCase()}`,
    `css=${cssPath(el)}`,
  ]
    .filter(Boolean)
    .join('  |  ');
}

const HILITE = 'porthole-devpick-hilite';

export default function DevPick() {
  const [active, setActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const hoverRef = useRef<Element | null>(null);

  // Ctrl+F12 toggle / Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'F12') {
        e.preventDefault();
        setActive((a) => !a);
      } else if (e.key === 'Escape') {
        setActive(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!active) {
      hoverRef.current?.classList.remove(HILITE);
      hoverRef.current = null;
      return;
    }
    document.body.style.cursor = 'crosshair';

    const onMove = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || el === hoverRef.current) return;
      hoverRef.current?.classList.remove(HILITE);
      el.classList.add(HILITE);
      hoverRef.current = el;
    };

    // capture + preventDefault + stopPropagation:點按鈕不會觸發其原本行為
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element | null;
      if (!el) return;
      const loc = buildLoc(el);
      void copyText(loc);
      setToast(loc);
      setActive(false);
      window.setTimeout(() => setToast(null), 4000);
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      hoverRef.current?.classList.remove(HILITE);
      hoverRef.current = null;
    };
  }, [active]);

  return (
    <>
      <style>{`
        .${HILITE} { outline: 2px solid #ff4d4f !important; outline-offset: -1px !important;
                     background: rgba(255,77,79,0.08) !important; cursor: crosshair !important; }
      `}</style>
      {active && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 99999,
            background: '#ff4d4f',
            color: '#fff',
            font: '12px/24px monospace',
            textAlign: 'center',
            height: 24,
          }}
        >
          DEV PICK · 點任一元素複製定位器 · Esc 退出
        </div>
      )}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            zIndex: 99999,
            maxWidth: 520,
            background: '#1f1f1f',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 6,
            font: '12px/1.5 monospace',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            wordBreak: 'break-all',
          }}
        >
          已複製定位器:
          <br />
          {toast}
        </div>
      )}
    </>
  );
}
