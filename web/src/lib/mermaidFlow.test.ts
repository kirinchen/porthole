/**
 * mermaidFlow 測試 — 樣式語句(classDef / class / style / :::)不能被當成節點,存檔要原樣留著。
 * 用 node:test(內建,零額外依賴),node 原生 strip types 直接跑 .ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlow, serializeFlow, nodeStyles } from './mermaidFlow.ts';

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
