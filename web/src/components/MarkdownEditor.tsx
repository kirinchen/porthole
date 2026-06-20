/**
 * MarkdownEditor — CodeMirror 6 的 Obsidian 式 live-preview 編輯器。
 *
 * 行為:游標所在行(或選取涵蓋的行)顯示 markdown 原始碼,其餘行渲染成預覽
 *   ——標題字級、粗體、斜體、行內 code、連結、引用都即時呈現,語法符號則隱藏。
 *
 * 作法:一個 ViewPlugin 走 syntaxTree,對非 active 行的語法 mark 加 Decoration.replace
 *   隱藏、對內容加 Decoration.mark/line 上樣式;active 行不隱藏(露出原始碼供編輯)。
 *   mermaid fenced block 整塊換成互動 widget(自帶 預覽/編輯/GUI tabs),套用直接改寫文件。
 *
 * 非 markdown 檔不走這裡(Explore 用純 textarea)。父層以 key=path 強制每檔重掛。
 */
import { useEffect, useRef, createElement } from 'react';
import {
  EditorView,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { EditorState, StateField, type Range } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { createRoot, type Root } from 'react-dom/client';
import MermaidBlock from './MermaidBlock';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** 隱藏語法符號(零寬替換)。 */
const HIDE = Decoration.replace({});

/** fenced code 的語言標記(```後那段)。 */
function fenceInfo(state: EditorState, node: SyntaxNode): string {
  const info = node.getChild('CodeInfo');
  return info ? state.doc.sliceString(info.from, info.to).trim() : '';
}

/** fenced code 的內容(兩道 ``` 之間)。 */
function fenceCode(state: EditorState, node: SyntaxNode): string {
  const t = node.getChild('CodeText');
  return t ? state.doc.sliceString(t.from, t.to) : '';
}

/** 找第 index 個 mermaid fenced block 的 from/to(全文件,順序與渲染一致)。 */
function findMermaidBlock(state: EditorState, index: number): { from: number; to: number } | null {
  let i = 0;
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        if (fenceInfo(state, node.node) === 'mermaid') {
          if (i === index) found = { from: node.from, to: node.to };
          i++;
        }
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/** mermaid 區塊套用(編輯/GUI)→ 改寫文件中對應 fenced block。 */
function applyMermaidBlock(view: EditorView, index: number, newCode: string): void {
  const range = findMermaidBlock(view.state, index);
  if (!range) return;
  const insert = '```mermaid\n' + newCode.replace(/\s+$/, '') + '\n```';
  view.dispatch({ changes: { from: range.from, to: range.to, insert } });
}

/** 把 mermaid block 渲染成互動 box(React root 掛進 CM6 widget)。 */
class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly index: number,
  ) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code && o.index === this.index;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.setAttribute('data-loc', 'explore:edit:mermaid');
    const root = createRoot(dom);
    root.render(
      createElement(MermaidBlock, {
        code: this.code,
        onApply: (nc: string) => applyMermaidBlock(view, this.index, nc),
      }),
    );
    (dom as unknown as { _root: Root })._root = root;
    return dom;
  }
  destroy(dom: HTMLElement) {
    const root = (dom as unknown as { _root?: Root })._root;
    if (root) setTimeout(() => void root.unmount(), 0); // 避免在 render 期間 unmount
  }
  ignoreEvent() {
    return true; // widget 自行處理互動,不當成編輯器事件
  }
}

/** mermaid block widget 是 block / 跨行 replace → 只能走 StateField(不可由 plugin 提供)。 */
function buildMermaidDecos(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let i = 0;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        if (fenceInfo(state, node.node) === 'mermaid') {
          const code = fenceCode(state, node.node);
          const from = state.doc.lineAt(node.from).from;
          const to = state.doc.lineAt(node.to).to;
          ranges.push(
            Decoration.replace({ widget: new MermaidWidget(code, i), block: true }).range(from, to),
          );
          i++;
        }
        return false;
      }
      return undefined;
    },
  });
  return Decoration.set(ranges, true);
}

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => buildMermaidDecos(state),
  update: (value, tr) => (tr.docChanged ? buildMermaidDecos(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

const fence = (lines: string[]) => ['```mermaid', ...lines, '```'].join('\n');

/** 空白行右鍵可插入的範例(皆為各圖型的 GUI 可編輯子集)。 */
const GUI_SAMPLES: { label: string; code: string }[] = [
  {
    label: '＋ Flowchart',
    code: fence(['graph TD;', '    A[開始] --> B[處理];', '    A --> C[檢查];', '    B --> D[完成];', '    C --> D;']),
  },
  {
    label: '＋ State diagram',
    code: fence(['stateDiagram-v2', '    direction LR', '    [*] --> Idle', '    Idle --> Running : start', '    Running --> [*]']),
  },
  {
    label: '＋ ERD',
    code: fence([
      'erDiagram',
      '    CUSTOMER {',
      '        string name',
      '        string email PK',
      '    }',
      '    ORDER {',
      '        int id PK',
      '    }',
      '    CUSTOMER ||--o{ ORDER : places',
    ]),
  },
  {
    label: '＋ Class diagram',
    code: fence([
      'classDiagram',
      '    class Animal {',
      '        +int age',
      '        +eat() void',
      '    }',
      '    class Dog {',
      '        +bark() void',
      '    }',
      '    Animal <|-- Dog',
    ]),
  },
  {
    label: '＋ Sequence diagram',
    code: fence(['sequenceDiagram', '    participant A as Alice', '    participant B as Bob', '    A->>B: Hello', '    B-->>A: Hi']),
  },
  {
    label: '＋ Architecture',
    code: fence([
      'architecture-beta',
      '    group api(cloud)[API]',
      '    service db(database)[Database] in api',
      '    service server(server)[Server] in api',
      '    db:L -- R:server',
    ]),
  },
];

// 空白行右鍵選單(純 DOM,輕量;不引 Antd 進 CM6 widget 樹)。
let flowMenu: HTMLDivElement | null = null;
function closeFlowMenu() {
  if (flowMenu) {
    flowMenu.remove();
    flowMenu = null;
  }
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeyDown);
}
function onDocMouseDown(e: MouseEvent) {
  if (flowMenu && !flowMenu.contains(e.target as Node)) closeFlowMenu();
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeFlowMenu();
}
function showFlowMenu(x: number, y: number, onPick: (code: string) => void) {
  closeFlowMenu();
  const menu = document.createElement('div');
  menu.setAttribute('data-loc', 'explore:edit:flowmenu');
  menu.style.cssText =
    'position:fixed;z-index:1500;background:#fff;border:1px solid #d9d9d9;border-radius:6px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.15);padding:4px;font-size:13px;' +
    `left:${x}px;top:${y}px;`;
  const head = document.createElement('div');
  head.textContent = '插入圖表(GUI 可編輯)';
  head.style.cssText = 'padding:4px 12px;color:#999;font-size:11px;';
  menu.appendChild(head);
  for (const s of GUI_SAMPLES) {
    const item = document.createElement('div');
    item.textContent = s.label;
    item.style.cssText = 'padding:6px 12px;cursor:pointer;border-radius:4px;white-space:nowrap;';
    item.onmouseenter = () => (item.style.background = '#f0f0f0');
    item.onmouseleave = () => (item.style.background = '');
    // 用 mousedown(早於 outside-close 的 click),preventDefault 不讓編輯器失焦。
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onPick(s.code);
      closeFlowMenu();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  flowMenu = menu;
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeyDown);
}

/** 空白行右鍵 → 選單(列出各 GUI 圖型);點選 → 用該範例取代該空白行。 */
const flowContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    if (line.text.trim() !== '') return false; // 非空白行 → 用瀏覽器原生選單
    event.preventDefault();
    showFlowMenu(event.clientX, event.clientY, (code) => {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: code },
        selection: { anchor: line.from + code.length },
      });
      view.focus();
    });
    return true;
  },
});

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

        // mermaid block 由上面的 widget 接手,行內樣式跳過(否則與 block 裝飾重疊)。
        if (name === 'FencedCode' && fenceInfo(view.state, node.node) === 'mermaid') return false;

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
          mermaidField,
          flowContextMenu,
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
    return () => {
      closeFlowMenu();
      view.destroy();
    };
    // value 只用於初始化;父層以 key=path 強制每檔重掛,故不放進依賴。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} style={{ height: '100%' }} data-loc="explore:edit:cm" />;
}
