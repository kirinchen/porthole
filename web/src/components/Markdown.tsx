/**
 * Markdown — 共用的 markdown 渲染器(Explore 預覽 + Chat 訊息)。
 *  - remark-gfm。
 *  - ```mermaid 區塊 → MermaidBlock(預覽 / 編輯 / GUI tab);給 onMermaidChange 時可寫回。
 *  - 其餘 code 區塊照常 <pre><code>;行內 code 維持 <code>。
 *  呼叫端自行包 .md-preview(沿用既有樣式)。
 */
import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { message } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import MermaidBlock from './MermaidBlock';
import D2Block from './D2Block';
import ExcalidrawBlock from './ExcalidrawBlock';
import CodeBlock from './CodeBlock';
import { getCurrentFile } from '../lib/currentFile';
import { resolveLink } from '../lib/pathLink';
import { slugifyHeading, dedupeSlug, scrollToHeadingSlug } from '../lib/heading';

interface Props {
  children: string;
  /** 有給 → mermaid 區塊可編輯/GUI,套用後以 (舊碼, 新碼) 回寫。 */
  onMermaidChange?: (oldCode: string, newCode: string) => void;
  /** 有給 → 標題加 GitHub 式定位錨點(id + hover `#`,點擊捲動 + 複製章節連結)。 */
  headingAnchors?: boolean;
}

/** 從 react 子節點抽純文字(標題可能含粗體 / 行內 code)。 */
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

/** 章節錨點:更新網址列(?sec=slug,保留 #tab)、捲動、複製完整連結。 */
function jumpAndCopySection(slug: string): void {
  const rel = `${location.pathname}?sec=${encodeURIComponent(slug)}${location.hash || '#explore'}`;
  history.replaceState(null, '', rel);
  scrollToHeadingSlug(slug);
  const full = location.origin + rel;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(full).then(
      () => message.success('已複製章節連結'),
      () => message.info('已跳至章節(複製連結失敗)'),
    );
  } else {
    message.success('已跳至章節');
  }
}

/** 章節錨點的完整可分享 href(?sec=slug 保留 #tab)——供中鍵 / 複製網址 / hover 用。 */
function sectionHref(slug: string): string {
  return `${location.pathname}?sec=${encodeURIComponent(slug)}${location.hash || '#explore'}`;
}

/**
 * 產生某層標題的 react-markdown component:加 id / data-heading-slug + hover 錨點。
 * slug 經共用 seen Map 去重(同名標題補序號),與 mentionComplete 的 #section 對齊。
 */
function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', seen: Map<string, number>) {
  return function Heading({ children }: { children?: ReactNode }) {
    const slug = dedupeSlug(slugifyHeading(nodeText(children)), seen);
    return (
      <Tag id={slug} data-heading-slug={slug} className="md-heading">
        <a
          className="md-anchor"
          href={sectionHref(slug)}
          aria-label="複製章節連結"
          contentEditable={false}
          onClick={(e) => {
            e.preventDefault();
            jumpAndCopySection(slug);
          }}
        >
          <LinkOutlined />
        </a>
        {children}
      </Tag>
    );
  };
}

/** 建一組 h1–h6 component,共用同一個 seen Map(每次渲染重建 → 依文件序去重)。 */
function headingComponents() {
  const seen = new Map<string, number>();
  return {
    h1: makeHeading('h1', seen),
    h2: makeHeading('h2', seen),
    h3: makeHeading('h3', seen),
    h4: makeHeading('h4', seen),
    h5: makeHeading('h5', seen),
    h6: makeHeading('h6', seen),
  };
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
  const sec = internal?.section ? `?sec=${encodeURIComponent(internal.section)}` : '';
  const resolvedHref = internal
    ? `/${encodeURIComponent(internal.repo)}/${internal.path.split('/').map(encodeURIComponent).join('/')}${sec}#${hrefTab}`
    : href;
  const onClick = (e: React.MouseEvent) => {
    if (!target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 修飾鍵 → 瀏覽器預設(新分頁等)
    e.preventDefault();
    if (target.kind === 'external') {
      window.open(target.url, '_blank', 'noopener');
      return;
    }
    // 同檔章節錨點(#slug)→ 直接捲動,不重載檔案;更新網址列以便分享。
    if (target.section && target.path === (cur?.path ?? '') && target.repo === repo) {
      history.replaceState(
        null,
        '',
        `${location.pathname}?sec=${encodeURIComponent(target.section)}${location.hash || '#explore'}`,
      );
      scrollToHeadingSlug(target.section);
      return;
    }
    window.dispatchEvent(new CustomEvent('porthole:navigate', { detail: target }));
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

export default function Markdown({ children, onMermaidChange, headingAnchors }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // 連結:相對路徑以目前檔為基準解析 → SPA 導航(見 MdLink)
        a: ({ href, children: c }) => <MdLink href={href}>{c}</MdLink>,
        // 標題:給預覽時加 GitHub 式定位錨點(id + hover `#`)。每次渲染重建 → seen Map 依
        // 文件序去重(同名標題補序號);穩定 Map 會在 re-render 累加而算錯,故不快取。
        ...(headingAnchors ? headingComponents() : {}),
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
            // fenced code:與編輯器共用語言 parser 做語法高亮(清單外語言 → 純文字)。
            const lang = (/\blanguage-([\w+#-]+)/.exec(cls)?.[1] ?? '').toLowerCase();
            return <CodeBlock code={text} lang={lang} />;
          }
          return <code className={cls}>{c}</code>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
