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
import D2Block from './D2Block';
import ExcalidrawBlock from './ExcalidrawBlock';
import { getCurrentFile } from '../lib/currentFile';
import { resolveLink } from '../lib/pathLink';

interface Props {
  children: string;
  /** 有給 → mermaid 區塊可編輯/GUI,套用後以 (舊碼, 新碼) 回寫。 */
  onMermaidChange?: (oldCode: string, newCode: string) => void;
}

/**
 * 預覽連結:相對路徑以「目前開啟檔」為基準解析(非瀏覽器頁面 URL),修掉
 * `_template.md` 被當成 `/_template.md` 的 base 錯誤。
 *  - 內部 → SPA 導航(porthole:navigate),href 設成正規化的 /<repo>/<path>#<tab>(hover/中鍵也正確)。
 *  - 外部 → 新分頁。
 */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const repo = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
  const cur = getCurrentFile();
  const target = href ? resolveLink(href, repo, cur?.path ?? '') : null;
  const internal = target?.kind === 'internal' ? target : null;
  // 連結沒寫 #tab → href 補目前 tab(讓 hover / 中鍵開新分頁的網址一致、完整)。
  const hrefTab = internal ? internal.tab || location.hash.replace(/^#/, '') || 'explore' : '';
  const resolvedHref = internal
    ? `/${encodeURIComponent(internal.repo)}/${internal.path.split('/').map(encodeURIComponent).join('/')}#${hrefTab}`
    : href;
  const onClick = (e: React.MouseEvent) => {
    if (!target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 修飾鍵 → 瀏覽器預設(新分頁等)
    e.preventDefault();
    if (target.kind === 'external') window.open(target.url, '_blank', 'noopener');
    else window.dispatchEvent(new CustomEvent('porthole:navigate', { detail: target }));
  };
  return (
    <a
      href={resolvedHref}
      onClick={onClick}
      {...(target?.kind === 'external' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

export default function Markdown({ children, onMermaidChange }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // 連結:相對路徑以目前檔為基準解析 → SPA 導航(見 MdLink)
        a: ({ href, children: c }) => <MdLink href={href}>{c}</MdLink>,
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
          if (/\blanguage-d2\b/.test(cls)) {
            return (
              <D2Block
                code={text}
                onApply={onMermaidChange ? (nc) => onMermaidChange(text, nc) : undefined}
              />
            );
          }
          if (/\blanguage-excalidraw\b/.test(cls)) {
            return (
              <ExcalidrawBlock
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
