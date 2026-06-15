/**
 * ContentPick — 內容挑選器(類似 DevPick,但抓的是元素的「資料內容」)。
 * 用途:像 Cursor 的 text mention —— 點畫面上任一塊內容(如 Explore 預覽的段落),
 * 把文字帶進 Chat 輸入框當引用,方便跟 agent 討論。
 *
 *  - 由 `porthole:pick:start` 事件啟動(Chat 的「引用內容」鈕派發)。
 *  - hover 高亮游標下元素;click → 取其文字 → 派發 `porthole:mention` {text}
 *    (Chat 接住附進輸入框、App 切到 Chat)→ 自動退出。
 *  - Esc 退出。不經剪貼簿(http 區網下 navigator.clipboard 不可用)。
 */
import { useEffect, useRef, useState } from 'react';
import { getCurrentFile } from '../lib/currentFile';

const HILITE = 'porthole-pick-hilite';

/** 推算來源 `path:line`:挑到的元素在某 data-file 容器內 → path;
 *  再以挑到文字的首行在原始內容中找出行號。找不到行號就只給 path。 */
function sourceOf(el: Element, text: string): string {
  const path = el.closest('[data-file]')?.getAttribute('data-file') || '';
  if (!path) return '';
  const cf = getCurrentFile();
  if (cf && cf.path === path) {
    const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim();
    if (firstLine) {
      const idx = cf.content.split('\n').findIndex((l) => l.includes(firstLine));
      if (idx >= 0) return `${path}:${idx + 1}`;
    }
  }
  return path;
}

/** 取元素可讀文字:收斂空白、去多餘空行、上限 4000 字。 */
function readContent(el: Element): string {
  return (el.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
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

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element | null;
      setActive(false);
      if (!el) return;
      const text = readContent(el);
      if (!text) return;
      const source = sourceOf(el, text);
      window.dispatchEvent(new CustomEvent('porthole:mention', { detail: { text, source } }));
      setToast((source ? `[${source}] ` : '') + text.slice(0, 60));
      window.setTimeout(() => setToast(null), 3000);
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
          PICK 內容 · 點任一塊內容帶入對話 · Esc 退出
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
          已帶入引用:{toast}
        </div>
      )}
    </>
  );
}
