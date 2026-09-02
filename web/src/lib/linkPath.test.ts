/**
 * linkPath 測試 — 連結網址欄的路徑補全解析。
 * 用 node:test(內建,零額外依賴),node 原生 strip types 直接跑 .ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLinkPathChoice,
  applyLinkSectionChoice,
  encodeLinkSegment,
  isPathExpression,
  parentInsertBase,
  parseLinkPathQuery,
  parseLinkSectionQuery,
} from './linkPath.ts';

const BASE = 'doc/Wiki/guides'; // 假設目前編輯 doc/Wiki/guides/xxx.md

test('觸發條件:只有 . 或 / 起手才進路徑模式', () => {
  assert.equal(isPathExpression('.'), true);
  assert.equal(isPathExpression('../a'), true);
  assert.equal(isPathExpression('/doc'), true);
  assert.equal(isPathExpression('https://example.com'), false);
  assert.equal(isPathExpression('mailto:a@b.c'), false);
  assert.equal(isPathExpression('doc/SPEC.md'), false);
  assert.equal(isPathExpression(''), false);
});

test('外部網址 / 空值不觸發補全', () => {
  assert.equal(parseLinkPathQuery('https://example.com/a', BASE), null);
  assert.equal(parseLinkPathQuery('', BASE), null);
  assert.equal(parseLinkPathQuery('SPEC.md', BASE), null);
});

test('`.` → 目前檔所在目錄', () => {
  assert.deepEqual(parseLinkPathQuery('.', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: '',
    insertBase: './',
  });
  assert.deepEqual(parseLinkPathQuery('./', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: '',
    insertBase: './',
  });
});

test('`..` → 上一層(含連續往上)', () => {
  assert.deepEqual(parseLinkPathQuery('..', BASE), {
    dir: 'doc/Wiki',
    prefix: '',
    insertBase: '../',
  });
  assert.deepEqual(parseLinkPathQuery('../', BASE), {
    dir: 'doc/Wiki',
    prefix: '',
    insertBase: '../',
  });
  assert.deepEqual(parseLinkPathQuery('../..', BASE), {
    dir: 'doc',
    prefix: '',
    insertBase: '../../',
  });
  assert.deepEqual(parseLinkPathQuery('../../', BASE), {
    dir: 'doc',
    prefix: '',
    insertBase: '../../',
  });
});

test('`..` 爬過 repo root 夾在 root(邊界仍由後端 path-guard 擋)', () => {
  assert.deepEqual(parseLinkPathQuery('../../../../..', BASE), {
    dir: '',
    prefix: '',
    insertBase: '../../../../../',
  });
  assert.deepEqual(parseLinkPathQuery('..', ''), { dir: '', prefix: '', insertBase: '../' });
});

test('`/` → repo 根', () => {
  assert.deepEqual(parseLinkPathQuery('/', BASE), { dir: '', prefix: '', insertBase: '/' });
  assert.deepEqual(parseLinkPathQuery('/doc/', BASE), {
    dir: 'doc',
    prefix: '',
    insertBase: '/doc/',
  });
  assert.deepEqual(parseLinkPathQuery('/doc/Wi', BASE), {
    dir: 'doc',
    prefix: 'Wi',
    insertBase: '/doc/',
  });
});

test('繼續打字 → 同層 + 過濾字首', () => {
  assert.deepEqual(parseLinkPathQuery('./bda', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: 'bda',
    insertBase: './',
  });
  assert.deepEqual(parseLinkPathQuery('../SPE', BASE), {
    dir: 'doc/Wiki',
    prefix: 'SPE',
    insertBase: '../',
  });
});

test('巢狀:多層鑽入,基準與字首各自正確', () => {
  assert.deepEqual(parseLinkPathQuery('../../Wiki/guides/dev', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: 'dev',
    insertBase: '../../Wiki/guides/',
  });
  assert.deepEqual(parseLinkPathQuery('/doc/Wiki/guides/', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: '',
    insertBase: '/doc/Wiki/guides/',
  });
});

test('裸相對隱藏檔字首(`.env`)不當成目錄', () => {
  assert.deepEqual(parseLinkPathQuery('.env', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: '.env',
    insertBase: '',
  });
  assert.equal(applyLinkPathChoice(parseLinkPathQuery('.env', BASE)!, '.env.example', false), '.env.example');
});

test('含 # / ? 不再補路徑(避免蓋掉錨點)', () => {
  assert.equal(parseLinkPathQuery('./SPEC.md#section', BASE), null);
  assert.equal(parseLinkPathQuery('./a.md?sec=x', BASE), null);
});

test('套用選擇:保留起手風格,資料夾補尾斜線續補', () => {
  const q = parseLinkPathQuery('.', BASE)!;
  assert.equal(applyLinkPathChoice(q, 'guides', true), './guides/');
  assert.equal(applyLinkPathChoice(q, 'SPEC.md', false), './SPEC.md');

  const up = parseLinkPathQuery('../', BASE)!;
  assert.equal(applyLinkPathChoice(up, 'SPEC.md', false), '../SPEC.md');

  const abs = parseLinkPathQuery('/doc/Wi', BASE)!;
  assert.equal(applyLinkPathChoice(abs, 'Wiki', true), '/doc/Wiki/');

  // 續補一層:上一步的結果再解析,基準要跟著往下。
  assert.deepEqual(parseLinkPathQuery('./guides/', 'doc'), {
    dir: 'doc/guides',
    prefix: '',
    insertBase: './guides/',
  });
});

test('中文檔名原樣保留(不 percent-encode)', () => {
  const q = parseLinkPathQuery('./', BASE)!;
  assert.equal(applyLinkPathChoice(q, '會議紀錄.md', false), './會議紀錄.md');
  assert.equal(applyLinkPathChoice(q, '中文資料夾', true), './中文資料夾/');
  assert.deepEqual(parseLinkPathQuery('./中文資', BASE), {
    dir: 'doc/Wiki/guides',
    prefix: '中文資',
    insertBase: './',
  });
  assert.deepEqual(parseLinkPathQuery('./中文資料夾/會議', BASE), {
    dir: 'doc/Wiki/guides/中文資料夾',
    prefix: '會議',
    insertBase: './中文資料夾/',
  });
});

test('逸出會破壞 markdown 連結語法的字元(空白 / 括號)', () => {
  assert.equal(encodeLinkSegment('my note.md'), 'my%20note.md');
  assert.equal(encodeLinkSegment('a(1).md'), 'a%281%29.md');
  assert.equal(encodeLinkSegment('會議 紀錄.md'), '會議%20紀錄.md');
  assert.equal(encodeLinkSegment('normal-name_1.md'), 'normal-name_1.md');
});

test('章節補全:`#` 起手 → 目前檔;數量正規化', () => {
  assert.deepEqual(parseLinkSectionQuery('#foo', BASE), {
    filePath: null,
    query: 'foo',
    insertBase: '#',
  });
  assert.deepEqual(parseLinkSectionQuery('##foo', BASE), {
    filePath: null,
    query: 'foo',
    insertBase: '#',
  });
  assert.deepEqual(parseLinkSectionQuery('#', BASE), { filePath: null, query: '', insertBase: '#' });
});

test('章節補全:`路徑#` → 該檔標題(相對 / 上層 / 絕對)', () => {
  assert.deepEqual(parseLinkSectionQuery('./a.md#foo', BASE), {
    filePath: 'doc/Wiki/guides/a.md',
    query: 'foo',
    insertBase: './a.md#',
  });
  assert.deepEqual(parseLinkSectionQuery('../other.md#', BASE), {
    filePath: 'doc/Wiki/other.md',
    query: '',
    insertBase: '../other.md#',
  });
  assert.deepEqual(parseLinkSectionQuery('/x/y.md#sec', BASE), {
    filePath: 'x/y.md',
    query: 'sec',
    insertBase: '/x/y.md#',
  });
});

test('章節補全:外部網址 / slug 後含空白或斜線 → 不觸發', () => {
  assert.equal(parseLinkSectionQuery('https://a.com#top', BASE), null);
  assert.equal(parseLinkSectionQuery('mailto:x@y.z#a', BASE), null);
  assert.equal(parseLinkSectionQuery('#a b', BASE), null); // slug 不含空白
  assert.equal(parseLinkSectionQuery('#a/b', BASE), null); // slug 不含斜線
  assert.equal(parseLinkSectionQuery('./a.md', BASE), null); // 無 # → 非章節模式
});

test('章節補全:套用選擇 → `<路徑>#<slug>`', () => {
  assert.equal(applyLinkSectionChoice(parseLinkSectionQuery('#前', BASE)!, '前言'), '#前言');
  assert.equal(applyLinkSectionChoice(parseLinkSectionQuery('##特', BASE)!, '特徵集'), '#特徵集');
  assert.equal(
    applyLinkSectionChoice(parseLinkSectionQuery('./a.md#', BASE)!, '概述'),
    './a.md#概述',
  );
});

test('上一層 insertBase 推導', () => {
  assert.equal(parentInsertBase('./'), '../');
  assert.equal(parentInsertBase(''), '../');
  assert.equal(parentInsertBase('../'), '../../');
  assert.equal(parentInsertBase('../../'), '../../../');
  assert.equal(parentInsertBase('./a/b/'), './a/');
  assert.equal(parentInsertBase('./a/'), './');
  assert.equal(parentInsertBase('../a/'), '../');
  assert.equal(parentInsertBase('/doc/Wiki/'), '/doc/');
  assert.equal(parentInsertBase('/doc/'), '/');
});
