/**
 * CodeBlock — 預覽用的 fenced code 高亮。與編輯器共用 lib/codeLanguages 的語言 parser,
 * 用 highlightTree + classHighlighter 產生 tok-* class 的 span,配 styles.css 的配色
 * (仿 CM6 defaultHighlightStyle),讓預覽與編輯器高亮一致。
 *
 * 語言 lazy dynamic import(已被編輯器載過則同步命中 desc.support 快取);
 * 清單外語言(如 cobol)或未指定 → 純文字。
 *
 * 右上角有複製鈕(GitHub 式):複製**原始碼字串**而非 DOM 選取 —— 高亮把程式碼切成一堆
 * span,靠滑鼠選取容易漏字或帶進行號;且 porthole 常走 http://<tailscale-ip>(非安全內容)
 * 沒有 navigator.clipboard,故一律用 lib/clipboard 的 copyText(內含 execCommand fallback)。
 * 鈕放在 wrapper 而非 <pre> 內,橫向捲動時才不會跟著捲走。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LanguageSupport } from '@codemirror/language';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { findCodeLanguage } from '../lib/codeLanguages';
import { copyText } from '../lib/clipboard';

export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [nodes, setNodes] = useState<ReactNode | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const desc = findCodeLanguage(lang);
    if (!desc) {
      setNodes(null); // 清單外 → 純文字
      return;
    }
    const apply = (support: LanguageSupport) => {
      if (cancelled) return;
      const tree = support.language.parser.parse(code);
      const out: ReactNode[] = [];
      let pos = 0;
      let key = 0;
      highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > pos) out.push(code.slice(pos, from));
        out.push(
          <span key={key++} className={classes}>
            {code.slice(from, to)}
          </span>,
        );
        pos = to;
      });
      if (pos < code.length) out.push(code.slice(pos));
      setNodes(out);
    };
    if (desc.support) {
      apply(desc.support); // 編輯器已載過 → 同步命中,不閃純文字
    } else {
      desc.load().then(apply).catch(() => {
        if (!cancelled) setNodes(null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const onCopy = () => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-codewrap">
      <button
        type="button"
        className="md-code-copy"
        onClick={onCopy}
        title={copied ? '已複製' : '複製程式碼'}
        aria-label="複製程式碼"
        data-loc="md:code:copy"
      >
        {copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
      </button>
      <pre className={`md-code${lang ? ` language-${lang}` : ''}`}>
        <code>{nodes ?? code}</code>
      </pre>
    </div>
  );
}
