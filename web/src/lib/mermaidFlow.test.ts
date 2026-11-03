/**
 * mermaidFlow 測試 — 樣式語句(classDef / class / style / :::)不能被當成節點,存檔要原樣留著。
 * 用 node:test(內建,零額外依賴),node 原生 strip types 直接跑 .ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlow, serializeFlow, nodeStyles, withReadableText } from './mermaidFlow.ts';

const SRC = `flowchart TD
    A[開始] --> B{判斷}
    B -->|是| C
    B --> D:::warn
    n6[外部]
    class n6,D,C hasPJ
    classDef hasPJ fill:#d6f5d6,stroke:#2e7d32
    classDef warn fill:#fff3cd;
    style A fill:#123456,color:#fff`;

test('class / classDef / style 不變節點,收進 extras', () => {
  const g = parseFlow(SRC);
  assert.deepEqual(g.nodes.map((n) => n.id), ['A', 'B', 'C', 'D', 'n6']);
  assert.equal(g.extras?.length, 4);
  assert.deepEqual(g.nodes.find((n) => n.id === 'D')?.classes, ['warn']);
});

test('nodeStyles:classDef 經 class / ::: 套上,style 直接蓋', () => {
  const st = nodeStyles(parseFlow(SRC));
  assert.deepEqual(st.get('n6'), { fill: '#d6f5d6', stroke: '#2e7d32' });
  assert.equal(st.get('D')?.fill, '#d6f5d6'); // hasPJ 後套,蓋過 warn
  assert.deepEqual(st.get('A'), { fill: '#123456', color: '#fff' });
  assert.equal(st.has('B'), false);
});

test('來回一趟樣式語句還在;刪掉的節點會從 class 清單濾掉', () => {
  const g = parseFlow(SRC);
  const out = serializeFlow(g);
  assert.match(out, /classDef hasPJ fill:#d6f5d6,stroke:#2e7d32/);
  assert.match(out, /class n6,D,C hasPJ/);
  assert.match(out, /D:::warn/);
  const again = parseFlow(out);
  assert.deepEqual(again.nodes.map((n) => n.id).sort(), ['A', 'B', 'C', 'D', 'n6']);

  const cut = serializeFlow({ ...g, nodes: g.nodes.filter((n) => n.id !== 'n6' && n.id !== 'A') });
  assert.match(cut, /class D,C hasPJ/);
  assert.doesNotMatch(cut, /style A/);
});

test('標籤的 <br/> → GUI 換行,存回再變 <br/>', () => {
  const g = parseFlow('flowchart TD\n  n4["不用 Obsidian 了<br/>自己寫 porthole"] -->|a<br>b| n5');
  assert.equal(g.nodes.find((n) => n.id === 'n4')?.label, '不用 Obsidian 了\n自己寫 porthole');
  assert.equal(g.edges[0].label, 'a\nb');
  const out = serializeFlow(g);
  assert.match(out, /n4\["不用 Obsidian 了<br\/>自己寫 porthole"\]/);
  assert.match(out, /-->\|a<br\/>b\| n5/);
});

test('withReadableText:淺色 fill 沒字色 → 補深字;已有 color / 深色 fill 不動', () => {
  const src = [
    'flowchart TD',
    '    classDef done fill:#d3f9d8,stroke:#2f9e44',
    '    classDef idea fill:#f1f3f5,stroke:#868e96,stroke-dasharray:4 3',
    '    classDef dark fill:#1b2b33,stroke:#000',
    '    classDef own fill:#fff,color:#c00',
    '    style A fill:#ffe8cc;',
  ].join('\n');
  const out = withReadableText(src).split('\n');
  assert.equal(out[1], '    classDef done fill:#d3f9d8,stroke:#2f9e44,color:#14232b');
  assert.equal(out[2], '    classDef idea fill:#f1f3f5,stroke:#868e96,stroke-dasharray:4 3,color:#14232b');
  assert.equal(out[3], '    classDef dark fill:#1b2b33,stroke:#000');
  assert.equal(out[4], '    classDef own fill:#fff,color:#c00');
  assert.equal(out[5], '    style A fill:#ffe8cc,color:#14232b;');
});
