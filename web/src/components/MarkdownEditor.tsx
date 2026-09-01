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
import { useEffect, useRef, useState, useImperativeHandle, forwardRef, createElement } from 'react';
import { Modal, Input, message } from 'antd';
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
import { syntaxTree, ensureSyntaxTree, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { Table } from '@lezer/markdown';
import { CODE_LANGUAGES } from '../lib/codeLanguages';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { mentionCompletionSource } from '../lib/mentionComplete';
import { createRoot, type Root } from 'react-dom/client';
import MermaidBlock from './MermaidBlock';
import D2Block from './D2Block';
import ExcalidrawBlock from './ExcalidrawBlock';
import TableBlock from './TableBlock';
import { getCurrentFile } from '../lib/currentFile';
import { resolveLink } from '../lib/pathLink';
import { api } from '../lib/api';
import { showLinkTip, closeLinkTip, type LinkEditDetail } from '../lib/linkTooltip';
import { slugifyHeading, dedupeSlug } from '../lib/heading';
import { copyText } from '../lib/clipboard';

/** 支援 GUI / 互動 widget 的 fenced 圖型語言。 */
const FENCE_LANGS = ['mermaid', 'd2', 'excalidraw'] as const;
type FenceLang = (typeof FENCE_LANGS)[number];
const FENCE_COMPONENT = { mermaid: MermaidBlock, d2: D2Block, excalidraw: ExcalidrawBlock } as const;

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 進編輯時初始捲到的行(0-based);用來延續 preview 的捲動位置。0/未給 = 頂端。 */
  initialLine?: number;
  /** 貼上剪貼簿圖片:存檔後回傳要插入 `![](path)` 的相對路徑;回 null 則不插入。 */
  onImagePaste?: (file: File) => Promise<string | null>;
}

export interface MarkdownEditorHandle {
  /** 目前編輯器頂端可見的行(0-based);退編輯時用來把位置帶回 preview。 */
  topLine(): number;
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

/** 找第 index 個「指定語言」fenced block 的 from/to(同語言內計數,順序與渲染一致)。 */
function findFenceBlock(
  state: EditorState,
  lang: FenceLang,
  index: number,
): { from: number; to: number } | null {
  let i = 0;
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        if (fenceInfo(state, node.node) === lang) {
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

/** 圖型區塊套用(編輯/GUI)→ 改寫文件中對應 fenced block(保留原語言)。 */
function applyFenceBlock(view: EditorView, lang: FenceLang, index: number, newCode: string): void {
  const range = findFenceBlock(view.state, lang, index);
  if (!range) return;
  const insert = '```' + lang + '\n' + newCode.replace(/\s+$/, '') + '\n```';
  view.dispatch({ changes: { from: range.from, to: range.to, insert } });
}

/** 找第 index 個 GFM Table 的整塊 from/to(以「行」為界,與渲染順序一致)。 */
function findTableBlock(state: EditorState, index: number): { from: number; to: number } | null {
  let i = 0;
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        if (i === index) {
          found = { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
        }
        i++;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/** 表格 GUI 套用 → 改寫文件中對應 Table 區塊。 */
function applyTableBlock(view: EditorView, index: number, newCode: string): void {
  const range = findTableBlock(view.state, index);
  if (!range) return;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: newCode.replace(/\s+$/, '') } });
}

/** GFM 表格 → GUI 編輯 widget(React root 掛進 CM6 block widget)。 */
class TableWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly index: number,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.code === this.code && o.index === this.index;
  }
  get estimatedHeight() {
    return 160;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    // flow-root:同 FenceWidget,建 BFC 讓子元件 margin 計入量測高度,避免下方行點擊偏移。
    dom.style.display = 'flow-root';
    dom.setAttribute('data-loc', 'explore:edit:table');
    // 突破 .cm-content 的 860px 正文閱讀寬:表格編輯器撐滿編輯窗格可視寬,避免欄位太擠。
    // 內容欄靠左(無 gutter),故 widget 左緣≈scroller 左緣;設寬為 scroller 可視寬即滿版。
    const fitWidth = () => {
      const w = view.scrollDOM.clientWidth;
      if (w > 0) dom.style.width = `${w - 4}px`;
    };
    fitWidth();
    const root = createRoot(dom);
    root.render(
      createElement(TableBlock, {
        code: this.code,
        onApply: (nc: string) => applyTableBlock(view, this.index, nc),
      }),
    );
    // 觀察 dom(高度變化)+ scroller(窗格寬變化,如拉動分割線)→ 重量測 / 重算滿版寬。
    const ro = new ResizeObserver(() => {
      fitWidth();
      view.requestMeasure();
    });
    ro.observe(dom);
    ro.observe(view.scrollDOM);
    (dom as unknown as { _root: Root; _ro: ResizeObserver })._root = root;
    (dom as unknown as { _root: Root; _ro: ResizeObserver })._ro = ro;
    return dom;
  }
  destroy(dom: HTMLElement) {
    const d = dom as unknown as { _root?: Root; _ro?: ResizeObserver };
    d._ro?.disconnect();
    if (d._root) setTimeout(() => void d._root!.unmount(), 0);
  }
  ignoreEvent() {
    return true;
  }
}

/** 把圖型 block(mermaid / d2)渲染成互動 box(React root 掛進 CM6 widget)。 */
class FenceWidget extends WidgetType {
  constructor(
    readonly lang: FenceLang,
    readonly code: string,
    readonly index: number,
  ) {
    super();
  }
  eq(o: FenceWidget) {
    return o.lang === this.lang && o.code === this.code && o.index === this.index;
  }
  // 圖型渲染完/切 tab 前的初估高度(供 CM6 建高度圖;實際高度由 ResizeObserver 校正)。
  get estimatedHeight() {
    return 320;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    // flow-root:建立 BFC,讓子元件(MermaidBlock 等)的上下 margin 計入本 widget
    // 的量測高度,不再 collapse 到 widget 之外。否則 CM6 量測不含該 margin,widget
    // 下方每一行的座標會累積偏移 → 點擊落到下一行、該行無法編輯。
    dom.style.display = 'flow-root';
    dom.setAttribute('data-loc', `explore:edit:${this.lang}`);
    const root = createRoot(dom);
    root.render(
      createElement(FENCE_COMPONENT[this.lang], {
        code: this.code,
        onApply: (nc: string) => applyFenceBlock(view, this.lang, this.index, nc),
        // 跨 remount 保留 GUI 狀態:存檔改寫文件 → widget 重建 → 元件 remount。
        sessionKey: `${this.lang}:${this.index}`,
      }),
    );
    // mermaid/d2/excalidraw 為非同步渲染,widget 掛載後高度才確定;若不通知 CM6
    // 重新量測,其高度圖會過時 → widget 下方各行的座標↔位置對映偏掉(點該行游標
    // 落到別行、打字進錯行)。以 ResizeObserver 在高度變動時 requestMeasure 校正。
    const ro = new ResizeObserver(() => view.requestMeasure());
    ro.observe(dom);
    (dom as unknown as { _root: Root; _ro: ResizeObserver })._root = root;
    (dom as unknown as { _root: Root; _ro: ResizeObserver })._ro = ro;
    return dom;
  }
  destroy(dom: HTMLElement) {
    const d = dom as unknown as { _root?: Root; _ro?: ResizeObserver };
    d._ro?.disconnect();
    if (d._root) setTimeout(() => void d._root!.unmount(), 0); // 避免在 render 期間 unmount
  }
  ignoreEvent() {
    return true; // widget 自行處理互動,不當成編輯器事件
  }
}

/** 圖型 / 表格 block widget 是 block / 跨行 replace → 只能走 StateField(不可由 plugin 提供)。 */
function buildFenceDecos(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const counter: Record<FenceLang, number> = { mermaid: 0, d2: 0, excalidraw: 0 }; // 同語言各自計數
  let tableIdx = 0; // GFM 表格各自計數
  // CM6 預設只增量解析到 viewport 附近;若不強制解析整份,初始 viewport 之下的
  // 第二個 ```mermaid / d2 / excalidraw fence 或表格 不在語法樹裡 → 掃不到、顯示成原始
  // 文字,要打字觸發重解析才出現。先 ensureSyntaxTree 把整份解析完(逾時才退回部分樹)。
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        const lang = fenceInfo(state, node.node);
        if ((FENCE_LANGS as readonly string[]).includes(lang)) {
          const l = lang as FenceLang;
          const code = fenceCode(state, node.node);
          const from = state.doc.lineAt(node.from).from;
          const to = state.doc.lineAt(node.to).to;
          ranges.push(
            Decoration.replace({ widget: new FenceWidget(l, code, counter[l]), block: true }).range(from, to),
          );
          counter[l]++;
        }
        return false;
      }
      if (node.name === 'Table') {
        const from = state.doc.lineAt(node.from).from;
        // 只 widget 化「行首」表格:blockquote(`> `)/ 清單縮排內的表格,node.from 會
        // 落在行首之後(前綴之後)。若連同前綴整行換成 widget,切出的原始碼含 `> ` →
        // 解析失敗變空 grid、寫回又丟前綴 → 摧毀 blockquote/list。這類巢狀表格保留純文字。
        if (node.from === from) {
          const to = state.doc.lineAt(node.to).to;
          const code = state.doc.sliceString(from, to);
          ranges.push(
            Decoration.replace({ widget: new TableWidget(code, tableIdx), block: true }).range(from, to),
          );
        }
        tableIdx++; // 巢狀表格也計數,與 findTableBlock(計數全部 Table)對齊 index
        return false;
      }
      return undefined;
    },
  });
  return Decoration.set(ranges, true);
}

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => buildFenceDecos(state),
  update: (value, tr) => (tr.docChanged ? buildFenceDecos(tr.state) : value),
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
  {
    label: '＋ Mind map',
    code: fence([
      'mindmap',
      '  root((主題))',
      '    分支A',
      '      子項1',
      '    分支B',
      '    分支C',
    ]),
  },
  {
    // D2 架構圖:容器是一等公民,支援「容器對容器」邊(mermaid architecture 做不到)。走後端 d2 CLI 渲染。
    label: '＋ D2 架構圖',
    code: ['```d2', 'api: API 層 {', '  server: 伺服器', '}', 'data: 資料層 {', '  db: 資料庫', '}', 'api -> data: 容器對容器', 'api.server -> data.db', '```'].join('\n'),
  },
  {
    // Excalidraw:自由白板(Google Drawing 式),GUI tab 開白板編輯。空白起手。
    label: '＋ Excalidraw 白板',
    code: ['```excalidraw', '{"type":"excalidraw","version":2,"source":"porthole","elements":[],"appState":{},"files":{}}', '```'].join('\n'),
  },
  {
    // GFM 表格:插入後由 TableWidget 接手成 GUI 試算表編輯。
    label: '＋ 表格',
    code: ['| 欄位 1 | 欄位 2 | 欄位 3 |', '| --- | --- | --- |', '| | | |'].join('\n'),
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
    'max-height:calc(100vh - 16px);overflow-y:auto;' +
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
  // 夾在視窗內:超出右/下邊 → 往左/上對齊(避免靠近底部時被切掉)。
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
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

/** 取 pos 所在 Link 節點的 URL(原始碼);非連結回 null。 */
function linkHrefAt(state: EditorState, pos: number): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  while (node && node.name !== 'Link') node = node.parent;
  if (!node) return null;
  const url = node.getChild('URL');
  return url ? state.doc.sliceString(url.from, url.to) : null;
}

/**
 * 連結點擊導航:點到 live-preview 的連結(非游標所在行)→ 解析 href:
 *  - 外部 → 新分頁;站內 → 派 `porthole:navigate`(App 切 repo/tab、Explore 開檔/展開)。
 * 游標所在行(編輯中)維持正常點擊,不導航。
 */
const linkNav = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest('.cm-link')) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const clickedLine = view.state.doc.lineAt(pos).number;
    const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    if (clickedLine === activeLine) return false; // 編輯中的行 → 不攔
    const href = linkHrefAt(view.state, pos);
    if (!href) return false;
    e.preventDefault();
    const repo = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
    const cur = getCurrentFile();
    const target = resolveLink(href, repo, cur?.path ?? '');
    if (!target) return true;
    if (target.kind === 'external') window.open(target.url, '_blank', 'noopener');
    else
      window.dispatchEvent(
        // Ctrl/Cmd+click → 開新分頁(否則取代目前分頁)
        new CustomEvent('porthole:navigate', { detail: { ...target, newTab: e.ctrlKey || e.metaKey } }),
      );
    return true;
  },
});

/** 取 pos 所在 Link 節點(整段 `[text](url)`);非連結回 null。供選字後編輯既有連結。 */
function linkNodeAt(state: EditorState, pos: number): { from: number; to: number; text: string; url: string } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  while (node && node.name !== 'Link') node = node.parent;
  if (!node) return null;
  const urlNode = node.getChild('URL');
  const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : '';
  const full = state.doc.sliceString(node.from, node.to);
  const m = /^\[([^\]]*)\]/.exec(full);
  return { from: node.from, to: node.to, text: m ? m[1] : full, url };
}

/**
 * 選字後「右鍵」點選區 → 於滑鼠處浮出「🔗 連結」鈕(取代原生選單);點它開 dialog。
 * detail.apply 走 view.dispatch 以 [text](url) 取代範圍;選區落在既有 Link 內則整段替換 + 預填 href。
 */
const linkContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const sel = view.state.selection.main;
    if (sel.empty) return false; // 無選取 → 交給下方 flowContextMenu / 原生選單
    event.preventDefault();
    const inLink = linkNodeAt(view.state, sel.from);
    const from = inLink ? inLink.from : sel.from;
    const to = inLink ? inLink.to : sel.to;
    const text = inLink ? inLink.text : view.state.doc.sliceString(sel.from, sel.to);
    const url = inLink ? inLink.url : '';
    showLinkTip(event.clientX, event.clientY, {
      text,
      url,
      apply: (md) => {
        view.dispatch({ changes: { from, to, insert: md }, selection: { anchor: from + md.length } });
        view.focus();
      },
    });
    return true;
  },
});

/**
 * 取某行(1-based)所屬標題的章節 slug;非 ATX 標題行回 null。
 * 走 syntaxTree 依文件序列舉 `ATXHeading[1-6]`(自動排除 fenced code 內的 `#`),
 * 以與預覽相同的 seen Map 做 dedupe,確保 slug(含 `-1`/`-2` 後綴)與 `?sec=` deep-link 對齊。
 */
function sectionSlugForLine(state: EditorState, lineNumber: number): string | null {
  const seen = new Map<string, number>();
  let result: string | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (!/^ATXHeading[1-6]$/.test(node.name)) return;
      const line = state.doc.lineAt(node.from);
      const text = line.text.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''); // 去前後 `#` 標記
      const slug = dedupeSlug(slugifyHeading(text), seen);
      if (line.number === lineNumber) result = slug;
    },
  });
  return result;
}

/** 複製章節 deep-link(`?sec=<slug>`,保留 #tab);格式對齊預覽的 jumpAndCopySection。 */
function copySectionLink(slug: string): void {
  const rel = `${location.pathname}?sec=${encodeURIComponent(slug)}${location.hash || '#explore'}`;
  const full = location.origin + rel;
  copyText(full).then((ok) => (ok ? message.success('已複製章節連結') : message.info('複製連結失敗')));
}

// hover 標題行 → 標題末端浮出「🔗 複製連結」鈕(純 DOM)。移到鈕上不消失(cancelHide),
// 移開有短延遲避免閃動;捲動 / unmount 收起。
let hoverTip: HTMLElement | null = null;
let hoverTipLine = -1;
let hoverHideTimer: number | null = null;
function cancelHoverHide() {
  if (hoverHideTimer != null) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
}
function closeHeadingTip() {
  cancelHoverHide();
  if (hoverTip) {
    hoverTip.remove();
    hoverTip = null;
  }
  hoverTipLine = -1;
}
function scheduleHeadingTipHide() {
  if (!hoverTip || hoverHideTimer != null) return;
  hoverHideTimer = window.setTimeout(closeHeadingTip, 240);
}
// LinkOutlined(與預覽 `.md-anchor` 同一顆 icon;純 DOM 需自帶 SVG)。
const LINK_ICON_SVG =
  '<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M574 665.4a8.03 8.03 0 00-11.3 0L446.5 781.6c-53.8 53.8-144.6 59.5-204 0-59.5-59.5-53.8-150.2 0-204l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3l-39.8-39.8a8.03 8.03 0 00-11.3 0L191.4 526.5c-84.6 84.6-84.6 221.5 0 306s221.5 84.6 306 0l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3L574 665.4zm258.6-474c-84.6-84.6-221.5-84.6-306 0L410.3 307.6a8.03 8.03 0 000 11.3l39.7 39.7c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c53.8-53.8 144.6-59.5 204 0 59.5 59.5 53.8 150.2 0 204L665.4 562.6a8.03 8.03 0 000 11.3l39.8 39.8c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c84.5-84.6 84.5-221.5-.1-306.1zM610.1 372.3a8.03 8.03 0 00-11.3 0L372.3 598.7a8.03 8.03 0 000 11.3l39.6 39.6c3.1 3.1 8.2 3.1 11.3 0l226.4-226.4c3.1-3.1 3.1-8.2 0-11.3l-39.5-39.6z"/></svg>';

// 比照預覽:標題「左側」灰色 LinkOutlined 錨點,hover 顯示、點擊複製章節連結。
function showHeadingTip(view: EditorView, lineFrom: number, lineNumber: number, slug: string) {
  cancelHoverHide();
  if (hoverTip && hoverTipLine === lineNumber) return; // 同一標題行 → 不重建
  closeHeadingTip();
  const coords = view.coordsAtPos(lineFrom);
  if (!coords) return;
  const tip = document.createElement('a');
  tip.setAttribute('data-loc', 'explore:edit:headingtip');
  tip.setAttribute('title', '複製章節連結');
  tip.setAttribute('aria-label', '複製章節連結');
  tip.innerHTML = LINK_ICON_SVG;
  tip.style.cssText =
    'position:fixed;z-index:1500;display:inline-flex;align-items:center;cursor:pointer;' +
    'color:#8c8c8c;font-size:14px;line-height:1;padding:2px;';
  tip.onmouseenter = () => {
    cancelHoverHide();
    tip.style.color = '#1677ff';
  };
  tip.onmouseleave = () => {
    tip.style.color = '#8c8c8c';
    closeHeadingTip();
  };
  tip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    copySectionLink(slug);
    closeHeadingTip();
  });
  document.body.appendChild(tip);
  const rect = tip.getBoundingClientRect();
  // 置於標題文字左側(比照預覽 `.md-anchor` left:-1.15em);夾在視窗內。
  const left = Math.max(2, coords.left - rect.width - 4);
  const top = Math.max(8, Math.min(coords.top + (coords.bottom - coords.top) / 2 - rect.height / 2, window.innerHeight - rect.height - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  hoverTip = tip;
  hoverTipLine = lineNumber;
}
/** hover 到標題行 → 顯示複製連結鈕;非標題行 / 離開 / 捲動 → 收起(帶延遲)。 */
const headingLinkHover = EditorView.domEventHandlers({
  mousemove(e, view) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) {
      scheduleHeadingTipHide();
      return false;
    }
    const line = view.state.doc.lineAt(pos);
    // 便宜前篩:非 `#…` 行直接跳過(避免每次 mousemove 走 syntaxTree)。
    if (!/^#{1,6}\s/.test(line.text)) {
      scheduleHeadingTipHide();
      return false;
    }
    const slug = sectionSlugForLine(view.state, line.number);
    if (!slug) {
      scheduleHeadingTipHide();
      return false;
    }
    showHeadingTip(view, line.from, line.number, slug);
    return false;
  },
  mouseleave() {
    scheduleHeadingTipHide();
    return false;
  },
  scroll() {
    closeHeadingTip();
    return false;
  },
});

/** 圖片 src 解析:相對路徑以「目前開啟檔」為基準 → /api/:repo/raw;外部 / data: 原樣。 */
function resolveRawSrc(src: string): string {
  const repo = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
  const cur = getCurrentFile();
  const target = src ? resolveLink(src, repo, cur?.path ?? '') : null;
  if (target?.kind === 'internal') return api.rawUrl(target.repo, target.path);
  if (target?.kind === 'external') return target.url;
  return src;
}

/** live-preview 內嵌圖片:非 active 行的 `![alt](url)` 換成 <img>(相對路徑解析成 raw)。 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  get estimatedHeight() {
    return 120;
  }
  toDOM(view: EditorView) {
    const img = document.createElement('img');
    img.src = resolveRawSrc(this.src);
    img.alt = this.alt;
    img.style.cssText = 'max-width:100%;max-height:360px;vertical-align:bottom;border-radius:4px;';
    img.addEventListener('load', () => view.requestMeasure()); // 載入後重量測,修正行位
    img.addEventListener('error', () => {
      img.replaceWith(document.createTextNode(`🖼 ${this.alt || this.src}`));
    });
    return img;
  }
  ignoreEvent() {
    return false; // 點圖 → CM6 定位游標 → 該行變 active → 露出原始碼供編輯
  }
}

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

        // 圖型 block(mermaid / d2)由 widget 接手,行內樣式跳過(否則與 block 裝飾重疊)。
        if (name === 'FencedCode' && (FENCE_LANGS as readonly string[]).includes(fenceInfo(view.state, node.node)))
          return false;
        // 表格由 TableWidget 接手 → 行內樣式跳過(整塊被 widget 取代)。
        if (name === 'Table') return false;

        // 圖片 ![alt](url):非 active 行整塊換成 <img> widget;active 行露原始碼。
        // 不論如何都 return false(跳過子節點 URL/LinkMark,避免與 replace 重疊或部分隱藏)。
        if (name === 'Image') {
          if (!lineIsActive(node.from)) {
            const m = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(
              doc.sliceString(node.from, node.to),
            );
            if (m) {
              const url = m[2].replace(/^<|>$/g, ''); // 去掉 <url> 尖括號形式
              ranges.push(
                Decoration.replace({ widget: new ImageWidget(url, m[1]) }).range(node.from, node.to),
              );
            }
          }
          return false;
        }

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

const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { value, onChange, initialLine, onImagePaste },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onImagePasteRef = useRef(onImagePaste); // 供一次性建立的 paste extension 取最新 callback
  onImagePasteRef.current = onImagePaste;
  // 連結編輯 dialog:由選字右鍵浮動鈕派 porthole:edit-link 事件開啟。
  // detail.apply 決定寫回來源(CM6 dispatch / table cell 字串);dialog 只負責 UI。
  const [link, setLink] = useState<{ open: boolean; text: string; url: string; apply: (md: string) => void }>({
    open: false,
    text: '',
    url: '',
    apply: () => {},
  });

  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<LinkEditDetail>).detail;
      setLink({ open: true, text: d.text, url: d.url, apply: d.apply });
    };
    window.addEventListener('porthole:edit-link', onEdit);
    return () => window.removeEventListener('porthole:edit-link', onEdit);
  }, []);

  // 套用:以 [文字](網址) 交給來源 apply 回寫。網址必填。
  const applyLink = () => {
    const url = link.url.trim();
    if (!url) return;
    const text = link.text.trim() || url;
    link.apply(`[${text}](${url})`);
    setLink((l) => ({ ...l, open: false }));
  };
  const initialLineRef = useRef(initialLine); // mount 時取一次(每次進編輯為新 mount)
  initialLineRef.current = initialLine;

  useImperativeHandle(
    ref,
    () => ({
      topLine() {
        const view = viewRef.current;
        if (!view) return 0;
        const rect = view.scrollDOM.getBoundingClientRect();
        const pos = view.posAtCoords({ x: rect.left + 4, y: rect.top + 4 });
        if (pos == null) return 0;
        return view.state.doc.lineAt(pos).number - 1; // 1-based → 0-based
      },
    }),
    [],
  );

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          // Table 擴充:讓 GFM 表格進語法樹 → 由 TableWidget 取代成 GUI 編輯器。
          markdown({ extensions: [Table], codeLanguages: CODE_LANGUAGES }),
          // fenced code 語法上色:把 lezer highlight tags 轉成帶色 class(fallback 不蓋 livePreview 樣式)。
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // @ 選檔 / # 選章節 自動完成(可混用 @file#section)
          autocompletion({ override: [mentionCompletionSource], icons: false }),
          EditorView.lineWrapping,
          mermaidField,
          linkContextMenu,
          flowContextMenu,
          linkNav,
          headingLinkHover,
          // 貼上剪貼簿圖片 → 交 onImagePaste 存檔,回傳路徑後於游標插入 ![](path)。
          EditorView.domEventHandlers({
            paste(event, view) {
              const cb = onImagePasteRef.current;
              if (!cb) return false;
              const items = event.clipboardData?.items;
              if (!items) return false;
              const imgs = Array.from(items)
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => f != null);
              if (imgs.length === 0) return false; // 非圖片 → 放行(正常貼文字)
              event.preventDefault();
              void (async () => {
                for (const f of imgs) {
                  const p = await cb(f);
                  if (!p) continue;
                  const md = `![](${p})`;
                  const sel = view.state.selection.main;
                  view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: md },
                    selection: { anchor: sel.from + md.length },
                  });
                }
                view.focus();
              })();
              return true;
            },
          }),
          livePreview,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    // 延續 preview 捲動位置:捲到指定行並把游標放該行首(避免 focus 又跳回頂)。
    const ln0 = initialLineRef.current;
    if (ln0 && ln0 > 0) {
      const ln = Math.min(ln0 + 1, view.state.doc.lines); // 0-based → 1-based,夾在文件範圍內
      const pos = view.state.doc.line(ln).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    }
    view.focus();
    return () => {
      closeFlowMenu();
      closeLinkTip();
      closeHeadingTip();
      viewRef.current = null;
      view.destroy();
    };
    // value 只用於初始化;父層以 key=path 強制每檔重掛,故不放進依賴。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div ref={host} style={{ height: '100%' }} data-loc="explore:edit:cm" />
      <Modal
        title="設定連結"
        open={link.open}
        onOk={applyLink}
        onCancel={() => setLink((l) => ({ ...l, open: false }))}
        okText="套用"
        cancelText="取消"
        okButtonProps={{ disabled: !link.url.trim() }}
        width={440}
        destroyOnClose
        data-loc="explore:edit:linkdialog"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>連結文字</div>
            <Input
              value={link.text}
              onChange={(e) => setLink((l) => ({ ...l, text: e.target.value }))}
              placeholder="顯示文字(留空則用網址)"
              data-loc="explore:edit:link:text"
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>網址</div>
            <Input
              autoFocus
              value={link.url}
              onChange={(e) => setLink((l) => ({ ...l, url: e.target.value }))}
              onPressEnter={applyLink}
              placeholder="https://… 或站內相對路徑"
              data-loc="explore:edit:link:url"
            />
          </div>
        </div>
      </Modal>
    </>
  );
});

export default MarkdownEditor;
