/**
 * mentionToken 測試 — composer 的 `@` agent / `.` 檔案觸發。
 * 用 node:test(內建,零額外依賴),node 原生 strip types 直接跑 .ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectMention, splitFileQuery, fileMentionText } from './mentionToken.ts';

const at = (s: string) => detectMention(s, s.length);

test('@ → agent,query 是 @ 後的字', () => {
  assert.deepEqual(at('問一下 @ke'), { kind: 'agent', at: 4, len: 3, query: 'ke' });
  assert.deepEqual(at('@'), { kind: 'agent', at: 0, len: 1, query: '' });
});

test('. → file;./ 前綴剝掉、單獨 . 列根目錄、.xx 當根下 dotfile', () => {
  assert.deepEqual(at('看 .'), { kind: 'file', at: 2, len: 1, query: '' });
  assert.deepEqual(at('看 ./doc/fo'), { kind: 'file', at: 2, len: 8, query: 'doc/fo' });
  assert.deepEqual(at('.cl'), { kind: 'file', at: 0, len: 3, query: '.cl' });
});

test('字中間的 @ / . 不觸發;打完空白就收', () => {
  assert.equal(at('a@b'), null);
  assert.equal(at('foo.md'), null);
  assert.equal(at('看 ./doc/a.md '), null);
  assert.equal(at('@kelp '), null);
});

test('游標不在尾端時只看游標前', () => {
  assert.deepEqual(detectMention('x @ke 後面', 5), { kind: 'agent', at: 2, len: 3, query: 'ke' });
});

test('splitFileQuery / fileMentionText', () => {
  assert.deepEqual(splitFileQuery(''), { dir: '.', prefix: '' });
  assert.deepEqual(splitFileQuery('doc/fo'), { dir: 'doc', prefix: 'fo' });
  assert.equal(fileMentionText('doc/a.md'), './doc/a.md');
});
