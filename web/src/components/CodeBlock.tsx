/**
 * CodeBlock — 預覽用的 fenced code 高亮。與編輯器共用 lib/codeLanguages 的語言 parser,
 * 用 highlightTree + classHighlighter 產生 tok-* class 的 span,配 styles.css 的配色
 * (仿 CM6 defaultHighlightStyle),讓預覽與編輯器高亮一致。
 *
 * 語言 lazy dynamic import(已被編輯器載過則同步命中 desc.support 快取);
 * 清單外語言(如 cobol)或未指定 → 純文字。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { LanguageSupport } from '@codemirror/language';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { findCodeLanguage } from '../lib/codeLanguages';

export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [nodes, setNodes] = useState<ReactNode | null>(null);

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

  return (
    <pre className={`md-code${lang ? ` language-${lang}` : ''}`}>
      <code>{nodes ?? code}</code>
    </pre>
  );
}
