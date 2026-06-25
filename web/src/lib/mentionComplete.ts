/**
 * mentionComplete — CM6 編輯器的 `@` / `#` 自動完成源(給 MarkdownEditor 用)。
 *
 *  - `@<query>` → 檔案 / 資料夾(repo 相對,lazy 逐層;資料夾選後補 `/` 續查、`../` 回上層)。
 *  - `#<query>` → 章節(標題):
 *      · `@file.md#<query>` → 該檔的標題(api.file 取內容解析 h1–h6)。
 *      · 單獨 `#<query>`(非 @ 後)→ 目前編輯檔的標題(直接解析 doc)。
 *  - 可混用 `@abc.md#chat1`。章節插入用「空白→-」的 slug 以維持單一 token。
 *  列檔複用 GET /api/:repo/tree(單層,path-guard 擋逃逸)。
 */
import {
  type CompletionContext,
  type CompletionResult,
  type Completion,
  startCompletion,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { api, type TreeItem } from './api';

function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

/** 標題 → 單一 token slug(空白收成 -,保留中文等)。 */
function slugifyHeading(h: string): string {
  return h.trim().replace(/\s+/g, '-');
}

/** query → 要列的目錄(相對 repo root)+ 過濾 prefix。 */
function splitQuery(query: string): { dir: string; prefix: string } {
  const slash = query.lastIndexOf('/');
  if (slash === -1) return { dir: '.', prefix: query };
  return { dir: query.slice(0, slash) || '.', prefix: query.slice(slash + 1) };
}

/** 從 markdown 取 ATX 標題文字(h1–h6)。 */
function headingsFromMarkdown(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** 選資料夾:插入 `name/` 並重新觸發完成(續查下一層)。 */
function applyFolder(name: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const insert = `${name}/`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    startCompletion(view);
  };
}

function sectionResult(from: number, heads: string[], query: string): CompletionResult {
  const q = query.toLowerCase();
  const options: Completion[] = heads
    .filter((h) => slugifyHeading(h).toLowerCase().includes(q) || h.toLowerCase().includes(q))
    .map((h) => ({ label: h, type: 'property', apply: slugifyHeading(h) }));
  return { from, options, validFor: /^[^\s#@]*$/ };
}

/** CM6 完成源:依游標前文字判 @ / # 模式。回 null = 不適用。 */
export async function mentionCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const before = context.state.sliceDoc(Math.max(0, context.pos - 400), context.pos);
  const repo = repoFromUrl();

  // 1) @file#section → 該檔標題
  let m = /(?:^|\s)@([^\s@#]+)#([^\s#@]*)$/.exec(before);
  if (m) {
    const filePath = m[1];
    const query = m[2];
    let heads: string[] = [];
    try {
      const f = await api.file(repo, filePath);
      heads = headingsFromMarkdown(f.content);
    } catch {
      heads = [];
    }
    return sectionResult(context.pos - query.length, heads, query);
  }

  // 2) 單獨 #section → 目前編輯檔標題
  m = /(?:^|\s)#([^\s#@]*)$/.exec(before);
  if (m) {
    const query = m[1];
    const heads = headingsFromMarkdown(context.state.doc.toString());
    return sectionResult(context.pos - query.length, heads, query);
  }

  // 3) @file → 檔案 / 資料夾(lazy 逐層)
  m = /(?:^|\s)@([^\s@#]*)$/.exec(before);
  if (m) {
    const query = m[1];
    const { dir, prefix } = splitQuery(query);
    let items: TreeItem[] = [];
    try {
      const r = await api.tree(repo, dir);
      items = r.items;
    } catch {
      items = []; // 多半逃出 repo root 被 path-guard 擋
    }
    const options: Completion[] = [];
    if (dir !== '.') options.push({ label: '../', type: 'folder', apply: applyFolder('..') });
    for (const it of items) {
      if (it.type === 'dir') options.push({ label: `${it.name}/`, type: 'folder', apply: applyFolder(it.name) });
      else options.push({ label: it.name, type: 'file' });
    }
    return { from: context.pos - prefix.length, options, validFor: /^[^\s@#/]*$/ };
  }

  return null;
}
