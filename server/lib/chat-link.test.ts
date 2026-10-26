import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileSlug,
  pathHex,
  splitRel,
  linkSuffix,
  linkedThreadName,
  reslug,
  readLink,
  setLink,
  mentionedAgents,
  agentContext,
} from './chat-link.ts';

test('fileSlug:副檔名的點換成連字號', () => {
  assert.equal(fileSlug('silent-story-ide.md'), 'silent-story-ide-md');
  assert.equal(fileSlug('SPEC.md'), 'SPEC-md');
});

test('fileSlug:中文 / 空白 / 奇怪字元收斂,且不留首尾的 - _', () => {
  assert.equal(fileSlug('我的筆記.md'), '____-md'); // 4 個中文字 → 4 個底線
  assert.equal(fileSlug('a b.txt'), 'a_b-txt');
  assert.equal(fileSlug('..md'), 'md'); // 連續 - 折疊 + 去首尾
});

test('fileSlug:沒東西剩下 → file(檔名不能是空的)', () => {
  assert.equal(fileSlug('.'), 'file');
});

test('splitRel:拆資料夾與檔名', () => {
  assert.deepEqual(splitRel('doc/note/a.md'), { dir: 'doc/note', base: 'a.md' });
  assert.deepEqual(splitRel('a.md'), { dir: '', base: 'a.md' });
  assert.deepEqual(splitRel('./a.md'), { dir: '', base: 'a.md' });
});

test('pathHex:12 碼 hex,同一個檔的各種寫法同碼、不同檔不同碼', () => {
  const h = pathHex('doc/note/a.md');
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(h, pathHex('./doc/note/a.md'));
  assert.equal(h, pathHex('doc/note/a.md/'));
  assert.notEqual(h, pathHex('doc/note/b.md'));
  assert.notEqual(h, pathHex('doc/chat/a.md'));
  assert.match(pathHex('a.md'), /^[0-9a-f]{12}$/); // repo 根下的檔
});

test('同名檔在不同資料夾 → 後綴不同(這就是 hex 存在的理由)', () => {
  assert.notEqual(linkSuffix('doc/a/README.md'), linkSuffix('doc/b/README.md'));
});

test('同夾、收斂後長得一樣的中文檔名 → 後綴仍不同(hex 算完整路徑才做得到)', () => {
  assert.equal(fileSlug('我的筆記.md'), fileSlug('你的筆記.md')); // 片段一樣
  assert.notEqual(linkSuffix('doc/我的筆記.md'), linkSuffix('doc/你的筆記.md')); // 後綴不一樣
});

test('linkedThreadName:沒 slug 用 chat', () => {
  const n = linkedThreadName('doc/note/silent-story-ide.md');
  assert.match(n, /^chat-silent-story-ide-md-[0-9a-f]{12}$/);
  const m = linkedThreadName('doc/note/silent-story-ide.md', 'ide-design-review');
  assert.match(m, /^ide-design-review-silent-story-ide-md-[0-9a-f]{12}$/);
});

test('reslug:只換 slug 段,後綴原封不動', () => {
  const rel = 'doc/note/a.md';
  const first = linkedThreadName(rel);
  const named = reslug(first, rel, 'my-topic');
  assert.equal(named, `my-topic${linkSuffix(rel)}`);
});

test('reslug:名字不帶該檔後綴 → null(不是這個檔的綁檔對話)', () => {
  assert.equal(reslug('thread-123', 'doc/note/a.md', 'x'), null);
  assert.equal(reslug(linkedThreadName('doc/note/a.md'), 'doc/note/b.md', 'x'), null);
});

test('readLink / setLink:沒 H1 → 註記放檔首', () => {
  const out = setLink('## 🧑 Human · 2026\n\nhi\n', 'doc/note/a.md');
  assert.ok(out.startsWith('<!-- porthole:link doc/note/a.md -->'));
  assert.equal(readLink(out), 'doc/note/a.md');
});

test('setLink:有 H1 → 註記緊接在 H1 下一行,H1 仍是第一行', () => {
  const out = setLink('# 標題\n\n## 🧑 Human · x\n\nhi\n', 'doc/note/a.md');
  const lines = out.split('\n');
  assert.equal(lines[0], '# 標題');
  assert.equal(lines[1], '<!-- porthole:link doc/note/a.md -->');
});

test('setLink:已有註記 → 取代,不會變兩行', () => {
  const once = setLink('# t\n', 'doc/a.md');
  const twice = setLink(once, 'doc/b.md');
  assert.equal(readLink(twice), 'doc/b.md');
  assert.equal(twice.match(/porthole:link/g)?.length, 1);
});

test('readLink:沒註記 → null', () => {
  assert.equal(readLink('# t\n\n## 🧑 Human · x\n'), null);
});

test('mentionedAgents:只認存在的兄弟 repo、排除自己、去重保序、句尾句點不算', () => {
  const repos = ['coral', 'kelp', 'tide'];
  assert.deepEqual(mentionedAgents('問 @tide 跟 @kelp,再 @tide 一次', repos, 'coral'), ['tide', 'kelp']);
  assert.deepEqual(mentionedAgents('@coral 自己 / @nope / a@kelp', repos, 'coral'), []);
  assert.deepEqual(mentionedAgents('交給 @kelp.', repos, 'coral'), ['kelp']);
});

test('agentContext:沒 tag 回空字串;有 tag 給 ../<repo> 對照', () => {
  assert.equal(agentContext([]), '');
  assert.match(agentContext(['kelp']), /@kelp = \.\.\/kelp/);
});
