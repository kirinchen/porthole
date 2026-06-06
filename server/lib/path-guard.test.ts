/**
 * path-guard 測試 — 安全命脈必須綠。
 * 用 node:test(內建,零額外依賴),tsx 跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGuard, PathGuardError } from './path-guard.ts';

/** 建一個臨時 base,內含 repoA(有個檔)、repoB,與一個 base 外的祕密檔。 */
function makeSandbox() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-pg-')));
  const base = path.join(tmp, 'project');
  const repoA = path.join(base, 'repoA');
  fs.mkdirSync(path.join(repoA, 'doc'), { recursive: true });
  fs.mkdirSync(path.join(base, 'repoB'), { recursive: true });
  fs.writeFileSync(path.join(repoA, 'doc', 'note.md'), '# hi');
  // base 外的祕密(模擬 /etc/passwd)
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET');
  return { tmp, base, repoA };
}

test('repoRoot:合法 repo 名解析到 base/<repo>', () => {
  const { base, repoA } = makeSandbox();
  const g = createGuard(base);
  assert.equal(g.repoRoot('repoA'), repoA);
});

test('repoRoot:含斜線 / .. / 空字串 → PathGuardError', () => {
  const { base } = makeSandbox();
  const g = createGuard(base);
  for (const bad of ['..', '.', '', 'a/b', '../repoA', '/etc', 'a\\b']) {
    assert.throws(() => g.repoRoot(bad), PathGuardError, `應拒絕: ${JSON.stringify(bad)}`);
  }
});

test('repoRoot:不存在的 repo 仍受邊界保護(realpathSafe 不爆)', () => {
  const { base } = makeSandbox();
  const g = createGuard(base);
  // 不存在但落在 base 內 → 允許(可能要建立)
  assert.ok(g.repoRoot('nope').endsWith('/nope'));
});

test('resolveInRepo:正常相對路徑', () => {
  const { base, repoA } = makeSandbox();
  const g = createGuard(base);
  assert.equal(g.resolveInRepo('repoA', 'doc/note.md'), path.join(repoA, 'doc', 'note.md'));
  assert.equal(g.resolveInRepo('repoA', '.'), repoA);
});

test('resolveInRepo:../ 逃逸 → PathGuardError', () => {
  const { base } = makeSandbox();
  const g = createGuard(base);
  for (const bad of ['../../secret.txt', '../repoB', '../../../../etc/passwd', 'doc/../../secret.txt']) {
    assert.throws(() => g.resolveInRepo('repoA', bad), PathGuardError, `應拒絕: ${bad}`);
  }
});

test('resolveInRepo:絕對路徑被當相對處理,不會跳出 repo', () => {
  const { base, repoA } = makeSandbox();
  const g = createGuard(base);
  // '/etc/passwd' 開頭斜線被剝掉 → repoA/etc/passwd(不存在但落在 repo 內)
  assert.equal(g.resolveInRepo('repoA', '/etc/passwd'), path.join(repoA, 'etc', 'passwd'));
});

test('resolveInRepo:symlink 逃逸 → PathGuardError', () => {
  const { tmp, base, repoA } = makeSandbox();
  const g = createGuard(base);
  const link = path.join(repoA, 'escape');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), link); // 指向 base 外
  assert.throws(() => g.resolveInRepo('repoA', 'escape'), PathGuardError, 'symlink 逃逸應擋下');
});

test('resolveInRepo:repo 內的 symlink 允許', () => {
  const { base, repoA } = makeSandbox();
  const g = createGuard(base);
  const link = path.join(repoA, 'inlink');
  fs.symlinkSync(path.join(repoA, 'doc'), link); // 指向 repo 內
  assert.equal(g.resolveInRepo('repoA', 'inlink'), path.join(repoA, 'doc'));
});
