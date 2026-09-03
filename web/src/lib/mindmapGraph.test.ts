/**
 * mindmapGraph 測試 — mindmap GUI 的「拉線改 parent → 序列化 → 讀回」round-trip。
 * 用 node:test(內建,零額外依賴),node 原生 strip types 直接跑 .ts。
 *
 * 主要迴歸目標(Tide #141「mindmap 拉新連線會讓既有邊消失」):
 *  1. 拉一條新連線後,**總邊數不變**(換掉 target 舊 parent 邊,不是多掉一條)。
 *  2. 邊 id 不撞號(撞號時 React 會用同 key 蓋掉另一條邊 → 真的掉邊)。
 *  3. 序列化 → 讀回後,parent 關係一條不差(不在存回時丟線)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMindmap, serializeMindmap } from './mermaidMindmap.ts';
import {
  buildHierarchyEdges,
  checkReparent,
  findRootId,
  graphToModel,
  hierarchyEdgeId,
  makeHierarchyEdge,
  modelToGraphNodes,
  reparentEdges,
  type MindmapGraphEdge,
  type MindmapGraphNode,
} from './mindmapGraph.ts';

/**
 * Tide #141 的 repro fixture:aura-stream `doc/note/目前穩定上片持續推進探討.md`
 * 裡那張 mindmap 在回報當下的原文(照抄,含前一輪 GUI 存檔留下的 `m2[...]` 與
 * 空文字節點 `m_4[""]`)。真檔之後還會被作者改,故複製成 fixture 固定住。
 */
const REPRO = [
  'mindmap',
  'root((穩定擴展))',
  '  無聲系列',
  '    m2["顧swellplot "]',
  '      鍾馗系列',
  '  surf-uncle',
  '    顧seasplice',
  '    m_4[""]',
].join('\n');

/* ───────────────── 測試小工具 ───────────────── */

/** 開一張圖:parse → 畫布節點 + 階層邊(等同 MindmapEditor 的 init)。 */
function openGraph(code: string): { nodes: MindmapGraphNode[]; edges: MindmapGraphEdge[] } {
  const model = parseMindmap(code);
  return { nodes: modelToGraphNodes(model), edges: buildHierarchyEdges(model) };
}

/** 依節點文字找 id(fixture 文字唯一)。 */
function idOf(nodes: MindmapGraphNode[], text: string): string {
  const hit = nodes.filter((n) => n.data.text.trim() === text);
  assert.equal(hit.length, 1, `節點文字 ${text} 應唯一命中`);
  return hit[0].id;
}

/** 邊集合 → 「parent 文字 → child 文字」的可比對字串集合。 */
function edgeLabels(nodes: MindmapGraphNode[], edges: MindmapGraphEdge[]): Set<string> {
  const text = (id: string) => nodes.find((n) => n.id === id)?.data.text.trim() ?? `?${id}`;
  return new Set(edges.map((e) => `${text(e.source)}→${text(e.target)}`));
}

/** 模型 → 「parent 文字 → child 文字」集合(存回後的階層,與 edgeLabels 可直接比)。 */
function modelEdgeLabels(code: string): Set<string> {
  const model = parseMindmap(code);
  const text = (key: string) => model.nodes.find((n) => n.key === key)?.text.trim() ?? `?${key}`;
  return new Set(
    model.nodes.filter((n) => n.parent !== undefined).map((n) => `${text(n.parent as string)}→${text(n.key)}`),
  );
}

/** 存檔:畫布 → mindmap 文字。 */
function saveGraph(g: { nodes: MindmapGraphNode[]; edges: MindmapGraphEdge[] }): string {
  return serializeMindmap(graphToModel(g.nodes, g.edges));
}

/* ───────────────── repro:拉新連線不該掉邊 ───────────────── */

test('#141 repro:鍾馗系列 → 顧seasplice 拉線後,邊數不變、只換掉 target 的舊 parent 邊', () => {
  const g = openGraph(REPRO);
  assert.equal(g.nodes.length, 7);
  assert.equal(g.edges.length, 6);

  const source = idOf(g.nodes, '鍾馗系列');
  const target = idOf(g.nodes, '顧seasplice');
  const rootId = findRootId(
    g.nodes.map((n) => n.id),
    g.edges,
  );
  assert.deepEqual(checkReparent(g.edges, source, target, rootId), { ok: true });

  const { edges: after, prevParent } = reparentEdges(g.edges, source, target);

  // 邊數守恆:新線進來、target 的舊 parent 邊退場,其餘一條都不能少。
  assert.equal(after.length, g.edges.length);
  assert.equal(prevParent, idOf(g.nodes, 'surf-uncle'));
  assert.deepEqual(
    edgeLabels(g.nodes, after),
    new Set([
      '穩定擴展→無聲系列',
      '無聲系列→顧swellplot',
      '顧swellplot→鍾馗系列',
      '穩定擴展→surf-uncle',
      'surf-uncle→', // surf-uncle → m_4(空文字節點)
      '鍾馗系列→顧seasplice',
    ]),
  );
  // 只有 target 的那條 incoming 被換掉,其他既有邊原封不動。
  const untouched = [...edgeLabels(g.nodes, g.edges)].filter((l) => l !== 'surf-uncle→顧seasplice');
  for (const l of untouched) assert.ok(edgeLabels(g.nodes, after).has(l), `既有邊不該消失:${l}`);
});

test('#141 repro:存回 markdown 再讀回,階層一條不差(不在 round-trip 丟線)', () => {
  const g = openGraph(REPRO);
  const source = idOf(g.nodes, '鍾馗系列');
  const target = idOf(g.nodes, '顧seasplice');
  const after = reparentEdges(g.edges, source, target).edges;

  const code = saveGraph({ nodes: g.nodes, edges: after });
  const reopened = openGraph(code);
  assert.equal(reopened.nodes.length, g.nodes.length, '節點數不可變');
  assert.equal(reopened.edges.length, after.length, '邊數不可變');
  assert.deepEqual(edgeLabels(reopened.nodes, reopened.edges), edgeLabels(g.nodes, after));
  assert.deepEqual(modelEdgeLabels(code), edgeLabels(g.nodes, after));
});

test('邊 id 由 target 導出 → 任何連線序列都不可能撞號(舊版 seq 撞號=React 蓋掉邊)', () => {
  const g = openGraph(REPRO);
  let edges = g.edges;
  const seq: [string, string][] = [
    ['鍾馗系列', '顧seasplice'],
    ['鍾馗系列', 'surf-uncle'],
    ['顧seasplice', '無聲系列'],
    ['穩定擴展', '顧seasplice'],
  ];
  for (const [s, t] of seq) {
    const source = idOf(g.nodes, s);
    const target = idOf(g.nodes, t);
    const rootId = findRootId(
      g.nodes.map((n) => n.id),
      edges,
    );
    if (!checkReparent(edges, source, target, rootId).ok) continue;
    edges = reparentEdges(edges, source, target).edges;
    assert.equal(edges.length, g.edges.length, '每次改 parent 邊數守恆');
    assert.equal(new Set(edges.map((e) => e.id)).size, edges.length, '邊 id 必須唯一');
    assert.equal(new Set(edges.map((e) => e.target)).size, edges.length, '每個節點至多一條 incoming');
  }
  assert.equal(hierarchyEdgeId('m3'), 'me-m3');
});

/* ───────────────── 改 parent 的守門 ───────────────── */

test('改 parent 守門:自連 / target 是 root / 掛到自己子孫底下 → 拒絕', () => {
  const g = openGraph(REPRO);
  const rootId = findRootId(
    g.nodes.map((n) => n.id),
    g.edges,
  );
  const root = idOf(g.nodes, '穩定擴展');
  const branch = idOf(g.nodes, '無聲系列');
  const leaf = idOf(g.nodes, '鍾馗系列');

  assert.equal(checkReparent(g.edges, leaf, leaf, rootId).ok, false); // 自連
  assert.equal(checkReparent(g.edges, leaf, root, rootId).ok, false); // target 是 root
  assert.equal(checkReparent(g.edges, leaf, branch, rootId).ok, false); // 掛到自己子孫底下 → 成環
  assert.equal(checkReparent(g.edges, branch, idOf(g.nodes, '顧seasplice'), rootId).ok, true);
});

/* ───────────────── 迴歸:多邊 / 同 source 多 target / 跨群組 ───────────────── */

const MULTI = [
  'mindmap',
  'root((主題))',
  '  群組A',
  '    a1',
  '    a2',
  '      a2x',
  '  群組B',
  '    b1',
  '    b2',
].join('\n');

test('迴歸:同一 source 接多個 target(多子節點)round-trip 不掉邊', () => {
  const g = openGraph(MULTI);
  let edges = g.edges;
  const hub = idOf(g.nodes, 'a1');
  for (const t of ['b1', 'b2', 'a2x']) {
    edges = reparentEdges(edges, hub, idOf(g.nodes, t)).edges;
  }
  assert.equal(edges.length, g.edges.length);
  assert.equal(edges.filter((e) => e.source === hub).length, 3, 'a1 應有 3 個子節點');

  const reopened = openGraph(saveGraph({ nodes: g.nodes, edges }));
  assert.equal(reopened.edges.length, edges.length);
  assert.deepEqual(edgeLabels(reopened.nodes, reopened.edges), edgeLabels(g.nodes, edges));
});

test('迴歸:跨群組連線(群組B 的節點掛到 群組A 底下)round-trip 保留', () => {
  const g = openGraph(MULTI);
  const edges = reparentEdges(g.edges, idOf(g.nodes, 'a2'), idOf(g.nodes, 'b1')).edges;
  const code = saveGraph({ nodes: g.nodes, edges });
  assert.ok(modelEdgeLabels(code).has('a2→b1'));
  assert.ok(!modelEdgeLabels(code).has('群組B→b1'));
  assert.equal(modelEdgeLabels(code).size, g.edges.length);
  // 縮排要跟著新階層走:b1 落在 a2(主題>群組A>a2,深度 2)之下 → 深度 3 = 6 空白。
  assert.match(code, /\n {6}b1(\n|$)/);
});

test('迴歸:把整個子樹搬到別的群組(深層階層)不丟後代邊', () => {
  const g = openGraph(MULTI);
  const edges = reparentEdges(g.edges, idOf(g.nodes, 'b2'), idOf(g.nodes, '群組A')).edges;
  const reopened = openGraph(saveGraph({ nodes: g.nodes, edges }));
  assert.deepEqual(
    edgeLabels(reopened.nodes, reopened.edges),
    new Set(['主題→群組B', '群組B→b1', '群組B→b2', 'b2→群組A', '群組A→a1', '群組A→a2', 'a2→a2x']),
  );
});

test('迴歸:icon / class / 形狀 / 引號文字在改 parent 後仍隨節點保留', () => {
  const src = [
    'mindmap',
    'root((主題))',
    '  branch{{六角}}',
    '    ::icon(fa fa-book)',
    '    :::urgent',
    '  另一支',
    '    x["含 (括號) 的文字"]',
  ].join('\n');
  const g = openGraph(src);
  const edges = reparentEdges(g.edges, idOf(g.nodes, '六角'), idOf(g.nodes, '含 (括號) 的文字')).edges;
  const model = parseMindmap(saveGraph({ nodes: g.nodes, edges }));
  const hex = model.nodes.find((n) => n.text === '六角');
  assert.equal(hex?.shape, 'hexagon');
  assert.equal(hex?.icon, 'fa fa-book');
  assert.equal(hex?.cls, 'urgent');
  const quoted = model.nodes.find((n) => n.text === '含 (括號) 的文字');
  assert.equal(quoted?.shape, 'square');
  assert.equal(quoted?.parent, hex?.key);
});

/* ───────────────── 存檔:單 root 不變式 / 空白節點 ───────────────── */

test('存檔:斷鏈的孤兒節點掛回 root,不靜默丟節點', () => {
  const g = openGraph(MULTI);
  // 手動砍掉 b1 的 incoming 邊(模擬使用者在畫布上刪邊)。
  const b1 = idOf(g.nodes, 'b1');
  const edges = g.edges.filter((e) => e.target !== b1);
  const model = graphToModel(g.nodes, edges);
  assert.equal(model.nodes.length, g.nodes.length);
  assert.equal(model.nodes.filter((n) => n.parent === undefined).length, 1, '恰好一個 root');
  assert.equal(model.nodes.find((n) => n.key === b1)?.parent, idOf(g.nodes, '主題'));
});

test('存檔:空文字節點不可序列化成 `[""]`(mermaid 文法不接受,整張圖會 parse 失敗)', () => {
  // 「新增子節點」後未命名 = 空文字。實測 mermaid 11:`a[""]` → Parse error
  // (Expecting 'NODE_DESCR', got 'NODE_DEND');`a[" "]` 可解析。
  const g = openGraph(MULTI);
  const nodes: MindmapGraphNode[] = [...g.nodes, { id: 'm_9', data: { text: '', shape: 'default' } }];
  const edges = [...g.edges, makeHierarchyEdge(idOf(g.nodes, '群組A'), 'm_9')];
  const code = saveGraph({ nodes, edges });
  assert.ok(!code.includes('[""]'), '不可出現空引號');
  assert.match(code, /m_9\[" "\]/);
  // 讀回仍是空文字節點,且掛在同一個 parent 底下。
  const model = parseMindmap(code);
  const blank = model.nodes.find((n) => n.mid === 'm_9');
  assert.equal(blank?.text, '');
  assert.equal(model.nodes.find((n) => n.key === blank?.parent)?.text, '群組A');
});

test('#141 fixture 原檔存回後可被 mermaid 接受(空節點改用 `[" "]`)', () => {
  const g = openGraph(REPRO);
  const code = saveGraph(g);
  assert.ok(!code.includes('[""]'));
  assert.deepEqual(modelEdgeLabels(code), edgeLabels(g.nodes, g.edges));
});
