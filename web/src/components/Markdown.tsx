/**
 * Markdown — 共用的 markdown 渲染器(Explore 預覽 + Chat 訊息)。
 *  - remark-gfm。
 *  - ```mermaid 區塊 → MermaidBlock(預覽 / 編輯 / GUI tab);給 onMermaidChange 時可寫回。
 *  - 其餘 code 區塊照常 <pre><code>;行內 code 維持 <code>。
 *  呼叫端自行包 .md-preview(沿用既有樣式)。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidBlock from './MermaidBlock';

interface Props {
  children: string;
  /** 有給 → mermaid 區塊可編輯/GUI,套用後以 (舊碼, 新碼) 回寫。 */
  onMermaidChange?: (oldCode: string, newCode: string) => void;
}

export default function Markdown({ children, onMermaidChange }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // pre 交給 code 自己決定包裝(mermaid 不能塞在 <pre> 裡)
        pre: ({ children: c }) => <>{c}</>,
        code: ({ className, children: c }) => {
          const cls = className ?? '';
          const text = String(c ?? '').replace(/\n$/, '');
          if (/\blanguage-mermaid\b/.test(cls)) {
            return (
              <MermaidBlock
                code={text}
                onApply={onMermaidChange ? (nc) => onMermaidChange(text, nc) : undefined}
              />
            );
          }
          const isBlock = /\blanguage-/.test(cls) || text.includes('\n');
          if (isBlock) {
            return (
              <pre>
                <code className={cls}>{text}</code>
              </pre>
            );
          }
          return <code className={cls}>{c}</code>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
