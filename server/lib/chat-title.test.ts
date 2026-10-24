/**
 * chat-title 測試 —— 檔名(英文 slug)與顯示標題(檔首 H1)分離的邏輯。
 * 重點在邊界:舊檔沒有 H1、對話內文自己帶 `# `、已有 H1 要取代而非再插一行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeThread, slugify, readH1, setH1, parseGenTitle } from './chat-title.ts';

// porthole 早期的 thread 檔:沒有標題,直接 append turn。
const LEGACY = '\n## 🧑 Human · 2026-06-27T16:07:31.366Z\n\n像是很多 OAuth API 都需要 redirect URL\n';
const TITLED = '# OAuth redirect URL 的區網解法\n\n## 🧑 Human · 2026-06-27T16:07:31.366Z\n\n內文\n';

test('readH1:舊檔(無標題)→ null,前端據此退回顯示檔名', () => {
  assert.equal(readH1(LEGACY), null);
});

test('readH1:檔首 H1 → 回中文標題', () => {
  assert.equal(readH1(TITLED), 'OAuth redirect URL 的區網解法');
});

test('readH1:對話內文裡的 `# ` 不算標題(遇 turn 標頭即停)', () => {
  const md = '\n## 🤖 Assistant · t\n\n# 這是回覆內文的標題\n';
  assert.equal(readH1(md), null);
});

test('setH1:舊檔 → 標題插到最前面,原內容與 turn 完整保留', () => {
  const out = setH1(LEGACY, '中文標題');
  assert.ok(out.startsWith('# 中文標題\n'));
  assert.ok(out.includes('## 🧑 Human · 2026-06-27T16:07:31.366Z'));
  assert.ok(out.includes('像是很多 OAuth API 都需要 redirect URL'));
  assert.equal(readH1(out), '中文標題');
});

test('setH1:已有標題 → 取代那一行,不會變成兩個 H1', () => {
  const out = setH1(TITLED, '換個標題');
  assert.equal(readH1(out), '換個標題');
  assert.equal(out.split('\n').filter((l) => /^#\s/.test(l)).length, 1);
  assert.ok(out.includes('## 🧑 Human · 2026-06-27T16:07:31.366Z'));
});

test('setH1 → readH1 round-trip(含標點 / 英數混排)', () => {
  for (const t of ['OAuth redirect URL 的區網解法', 'LAN 內 proxy:Linode 中轉', '只有中文標題']) {
    assert.equal(readH1(setH1(LEGACY, t)), t);
  }
});

test('slugify:純中文 → 空字串(呼叫端據此維持原檔名,不把檔名洗成一串 _)', () => {
  assert.equal(slugify('中文標題沒有英數'), '');
  assert.match(safeThread('中文標題沒有英數'), /^_+$/); // 直接拿去當檔名就是這種結果
});

test('slugify:英文 / 英數混排 → kebab-case', () => {
  assert.equal(slugify('OAuth Redirect URL'), 'oauth-redirect-url');
  assert.equal(slugify('  Linode proxy 中轉 2 '), 'linode-proxy-2');
});

test('slugify:中英混排 → 只留英數段,中文不會變成一串 _(手動改名的檔名來源)', () => {
  assert.equal(slugify('3090 24G 價格走勢'), '3090-24g'); // 不是 safeThread 的 3090_24G_____
  assert.equal(slugify('Linode 中轉 proxy'), 'linode-proxy');
});

test('parseGenTitle:兩行輸出 → 中文標題 + 英文 slug', () => {
  const r = parseGenTitle('OAuth redirect URL 的區網解法\noauth-redirect-url-lan-proxy\n');
  assert.equal(r.title, 'OAuth redirect URL 的區網解法');
  assert.equal(r.slug, 'oauth-redirect-url-lan-proxy');
});

test('parseGenTitle:claude 多吐空行 / 標題帶 `#` → 仍解得出', () => {
  const r = parseGenTitle('\n# OAuth 區網解法\n\noauth-lan-proxy\n\n');
  assert.equal(r.title, 'OAuth 區網解法');
  assert.equal(r.slug, 'oauth-lan-proxy');
});

test('parseGenTitle:只有一行(沒給 slug)→ slug 空,檔名維持原樣', () => {
  const r = parseGenTitle('只有標題沒有 slug');
  assert.equal(r.title, '只有標題沒有 slug');
  assert.equal(r.slug, '');
});
