/**
 * MarkdownEditor — CodeMirror 6 的 Obsidian 式 live-preview 編輯器。
 *
 * 行為:游標所在行(或選取涵蓋的行)顯示 markdown 原始碼,其餘行渲染成預覽
 *   ——標題字級、粗體、斜體、行內 code、連結、引用都即時呈現,語法符號則隱藏。
 *
 * 作法:一個 ViewPlugin 走 syntaxTree,對非 active 行的語法 mark 加 Decoration.replace
 *   隱藏、對內容加 Decoration.mark/line 上樣式;active 行不隱藏(露出原始碼供編輯)。
 *
 * 非 markdown 檔不走這裡(Explore 用純 textarea)。父層以 key=path 強制每檔重掛。
 */
import { useEffect, useRef } from 'react';
import {
  EditorView,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  keymap,
} from '@codemirror/view';
import { EditorState, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** 隱藏語法符號(零寬替換)。 */
const HIDE = Decoration.replace({});

/** 依游標位置決定哪些行要露出原始碼,其餘套 live-preview 裝飾。 */
function buildDecorations(view: EditorView): DecorationSet {
  const { doc } = view.state;

  // active 行 = 任一選取範圍涵蓋的行
  const active = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let l = a; l <= b; l++) active.add(l);
  }
  const lineIsActive = (pos: number) => active.has(doc.lineAt(pos).number);

  const ranges: Range<Decoration>[] = [];
  const seenLine = new Set<string>(); // 避免同一行重複加 line decoration
  const addLine = (pos: number, cls: string) => {
    const line = doc.lineAt(pos);
    const key = `${line.number}:${cls}`;
    if (seenLine.has(key)) return;
    seenLine.add(key);
    ranges.push(Decoration.line({ class: cls }).range(line.from));
  };
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) ranges.push(Decoration.mark({ class: cls }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    if (to > from) ranges.push(HIDE.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        const h = /^ATXHeading([1-6])$/.exec(name);
        if (h) {
          addLine(node.from, `cm-h${h[1]}`); // 標題字級永遠保留
          return;
        }
        if (name === 'StrongEmphasis') return void mark(node.from, node.to, 'cm-strong');
        if (name === 'Emphasis') return void mark(node.from, node.to, 'cm-em');
        if (name === 'InlineCode') return void mark(node.from, node.to, 'cm-code');
        if (name === 'Link') return void mark(node.from, node.to, 'cm-link');

        if (name === 'QuoteMark') {
          addLine(node.from, 'cm-quote');
          if (!lineIsActive(node.from)) hide(node.from, node.to);
          return;
        }
        // 純語法符號:非 active 行才隱藏,active 行露出供編輯
        if (
          name === 'HeaderMark' ||
          name === 'EmphasisMark' ||
          name === 'CodeMark' ||
          name === 'LinkMark' ||
          name === 'URL'
        ) {
          if (!lineIsActive(node.from)) hide(node.from, node.to);
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: '#fff' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Microsoft JhengHei', sans-serif",
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': { padding: '4px 0', maxWidth: '860px' },
  '.cm-line': { padding: '0 2px' },
  '.cm-h1': { fontSize: '1.8em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-h2': { fontSize: '1.5em', fontWeight: '700', lineHeight: '1.4' },
  '.cm-h3': { fontSize: '1.27em', fontWeight: '700' },
  '.cm-h4': { fontSize: '1.12em', fontWeight: '700' },
  '.cm-h5': { fontWeight: '700' },
  '.cm-h6': { fontWeight: '700', color: '#8c8c8c' },
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: '#f2f2f3',
    borderRadius: '4px',
    padding: '0.1em 0.35em',
    fontSize: '0.92em',
  },
  '.cm-link': { color: '#1677ff', textDecoration: 'underline', cursor: 'pointer' },
  '.cm-quote': { borderLeft: '3px solid #d9d9d9', paddingLeft: '12px', color: '#666' },
});

export default function MarkdownEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          EditorView.lineWrapping,
          livePreview,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    view.focus();
    return () => view.destroy();
    // value 只用於初始化;父層以 key=path 強制每檔重掛,故不放進依賴。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} style={{ height: '100%' }} data-loc="explore:edit:cm" />;
}
