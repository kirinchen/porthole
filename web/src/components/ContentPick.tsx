/**
 * ContentPick — 引用內容挑選器(類似 DevPick,但抓「資料內容」當引用)。
 * 用途:像 Cursor 的 mention —— 點畫面上的內容段落或左側檔案樹,產生一段「引用」
 * **複製到剪貼簿**(不自動插入),貼到 Chat / Session 給 agent,讓它知道你指哪一段。
 *
 *  - 由 `porthole:pick:start` 事件啟動(「引用內容」鈕派發)。
 *  - hover 高亮游標下元素;click:
 *      · 點到左側檔案樹(explore:tree)的節點 → 複製 `@<path>`(檔案引用)。
 *      · 點到內容(data-file 容器內)→ 複製 `@<path>#<標題路徑> (L<行號>)` + 引用內容。
 *  - 複製走 navigator.clipboard;http 區網不可用時退回 execCommand('copy')。
 *  - Esc 退出。
 */
import { useEffect, useRef, useState } from 'react';
import { getCurrentFile } from '../lib/currentFile';

const HILITE = 'porthole-pick-hilite';

/** 複製到剪貼簿;http 區網(非 secure context)無 navigator.clipboard → execCommand fallback。 */
function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => execCopy(text));
  }
  return Promise.resolve(execCopy(text)); // 同步執行,維持在使用者手勢(click)內
}
function execCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 由挑到的元素往回找標題階層(h1–h6),回傳由淺到深的標題文字(祖先路徑)。 */
function headingPath(el: Element): string[] {
  const root = el.closest('[data-file]');
  if (!root) return [];
  const heads = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  // 只留位於 el 之前(或就是 el)的標題
  const preceding = heads.filter(
    (h) => h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  // 由最後一個往前,維護遞減層級,組出祖先路徑
  const path: string[] = [];
  let minLevel = 7;
  for (let i = preceding.length - 1; i >= 0; i--) {
    const lvl = Number(preceding[i].tagName[1]);
    if (lvl < minLevel) {
      const t = (preceding[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t) path.unshift(t);
      minLevel = lvl;
    }
  }
  return path;
}

/** 推算挑到文字的起始行號(以 data-file 對應目前開啟檔內容比對);找不到回 null。 */
function lineOf(path: string, text: string): number | null {
  const cf = getCurrentFile();
  if (!cf || cf.path !== path) return null;
  const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim();
  if (!firstLine) return null;
  const idx = cf.content.split('\n').findIndex((l) => l.includes(firstLine));
  return idx >= 0 ? idx + 1 : null;
}

/** 取元素可讀文字:收斂空白、去多餘空行、上限 4000 字。 */
function readContent(el: Element): string {
  return (el.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/** 內容元素 → 引用字串:`@<path>#<標題路徑> (L<行號>)` 換行接引用內容。無 data-file 則只給文字。 */
function buildContentMention(el: Element, text: string): string {
  const path = el.closest('[data-file]')?.getAttribute('data-file') || '';
  if (!path) return text;
  const heads = headingPath(el);
  const line = lineOf(path, text);
  let header = `@${path}`;
  if (heads.length) header += `#${heads.join(' › ')}`;
  if (line) header += ` (L${line})`;
  return `${header}\n${text}`;
}

export default function ContentPick() {
  const [active, setActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const hoverRef = useRef<Element | null>(null);

  useEffect(() => {
    const onStart = () => setActive(true);
    window.addEventListener('porthole:pick:start', onStart);
    return () => window.removeEventListener('porthole:pick:start', onStart);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActive(false);
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

    const done = (mention: string) => {
      // execCopy 須在 click 手勢內同步執行(http 區網),故 copyToClipboard 對無 clipboard API 走同步路徑。
      void copyToClipboard(mention).then((ok) => {
        const head = mention.split('\n')[0];
        setToast((ok ? '已複製引用:' : '複製失敗(請手動選取):') + head.slice(0, 80));
        window.setTimeout(() => setToast(null), 3000);
      });
    };

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element | null;
      setActive(false);
      if (!el) return;
      // 1) 左側檔案樹節點 → @<path>(檔案引用)
      if (el.closest('[data-loc="explore:tree"]')) {
        const p = el.closest('[data-path]')?.getAttribute('data-path');
        if (p) done(`@${p}`);
        return; // 點到樹但非節點 → 不處理
      }
      // 2) 內容 → @<path>#<標題> (L<行號>) + 引用內容
      const text = readContent(el);
      if (!text) return;
      done(buildContentMention(el, text));
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
        .${HILITE} { outline: 2px solid #1677ff !important; outline-offset: -1px !important;
                     background: rgba(22,119,255,0.08) !important; cursor: crosshair !important; }
      `}</style>
      {active && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 99999,
            background: '#1677ff',
            color: '#fff',
            font: '12px/24px monospace',
            textAlign: 'center',
            height: 24,
          }}
          data-loc="contentpick:bar"
        >
          PICK 引用 · 點內容或左側檔案 → 複製引用到剪貼簿 · Esc 退出
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
            font: '12px/1.5 sans-serif',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            wordBreak: 'break-word',
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
