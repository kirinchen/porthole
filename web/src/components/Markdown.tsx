/**
 * Markdown — 共用的 markdown 渲染器(Explore 預覽 + Chat 訊息)。
 *  - remark-gfm。
 *  - ```mermaid 區塊 → MermaidBlock(渲染 SVG);給 onMermaidEdit 時 flowchart 顯示 GUI 編輯鈕。
 *  - 其餘 code 區塊照常 <pre><code>;行內 code 維持 <code>。
 *  呼叫端自行包 .md-preview(沿用既有樣式)。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidBlock from './MermaidBlock';

interface Props {
  children: string;
  onMermaidEdit?: (code: string) => void;
}

export default function Markdown({ children, onMermaidEdit }: Props) {
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
            return <MermaidBlock code={text} onGuiEdit={onMermaidEdit} />;
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
