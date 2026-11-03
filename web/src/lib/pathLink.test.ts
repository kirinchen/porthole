import { test } from 'node:test';
import assert from 'node:assert/strict';

// resolveLink 用 location.host 判斷同源網址;node 沒有 location → 補一個。
(globalThis as { location?: unknown }).location = { host: '100.114.93.81:4321' };
const { resolveLink } = await import('./pathLink.ts');

test('resolveLink:/run、/api 是後端路徑不是 repo → 當外部連結', () => {
  const run = 'http://100.114.93.81:4321/run/game-lab/candidates/jump-duel/prototype.html';
  assert.deepEqual(resolveLink(run, 'game-lab', 'candidates/index.md'), { kind: 'external', url: run });
  assert.deepEqual(resolveLink('/run/game-lab/x.html', 'game-lab', 'a.md'), {
    kind: 'external',
    url: '/run/game-lab/x.html',
  });
  assert.equal(resolveLink('/api/game-lab/raw?path=a.png', 'game-lab', 'a.md')?.kind, 'external');
});

test('resolveLink:同源的 repo 網址與 /runner 這種 repo 仍走站內', () => {
  const t = resolveLink('http://100.114.93.81:4321/game-lab/candidates/index.md', 'kelp', 'a.md');
  assert.equal(t?.kind, 'internal');
  assert.equal(resolveLink('/runner/a.md', 'kelp', 'a.md')?.kind, 'internal');
});
