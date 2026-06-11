/**
 * path-guard — porthole 的安全命脈(SPEC §2)。
 *
 * 所有 fs 讀寫、claude/tmux 的 CWD,一律先正規化(realpath)再驗證仍落在
 * basePath 之內;任何 `..` / symlink 逃逸出 base → 丟 PathGuardError(403)。
 *
 * 不靠 prompt,靠 code。這是把「web 變全機讀檔漏洞」擋掉的唯一防線。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 後備預設;正式以 env PORTHOLE_BASE 覆寫(見 .env.example)。用 homedir 組,
// 不寫死使用者名稱。
export const DEFAULT_BASE = path.join(os.homedir(), 'Desktop', 'project');

export class PathGuardError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}

/** realpath 的安全版:目標可能還不存在(如要寫的新檔)。
 *  解析「最深的既存祖先」的 realpath,再接上不存在的尾段,
 *  如此 symlink 也會被收斂掉,再交給邊界檢查。 */
function realpathSafe(target: string): string {
  let cur = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // 到根了
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const real = fs.realpathSync(cur);
  return tail.length ? path.join(real, ...tail) : real;
}

/** child 是否落在 parent 之內(含 parent 自身)。 */
function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent + path.sep);
}

export interface Guard {
  /** basePath 的 realpath。 */
  readonly base: string;
  /** repo 名 → `<base>/<repo>`,驗證後回傳 realpath。 */
  repoRoot(repo: string): string;
  /** repo 內相對路徑 → 絕對 realpath,驗證仍落在該 repo(因而也落在 base)內。 */
  resolveInRepo(repo: string, relPath?: string): string;
}

export function createGuard(baseDir: string): Guard {
  // base 自身也 realpath 一次(可能本身是 symlink)。base 必須存在。
  const realBase = fs.realpathSync(path.resolve(baseDir));

  function repoRoot(repo: string): string {
    if (
      !repo ||
      repo.includes('/') ||
      repo.includes('\\') ||
      repo.includes('\0') ||
      repo === '.' ||
      repo === '..'
    ) {
      throw new PathGuardError(`invalid repo name: ${JSON.stringify(repo)}`);
    }
    const candidate = realpathSafe(path.join(realBase, repo));
    if (!within(candidate, realBase)) {
      throw new PathGuardError(`repo escapes base: ${repo}`);
    }
    return candidate;
  }

  function resolveInRepo(repo: string, relPath = '.'): string {
    const root = repoRoot(repo);
    // 把 relPath 一律當「相對於 repo root」:剝掉開頭斜線,避免被當成絕對路徑。
    const clean = String(relPath).replace(/^[/\\]+/, '');
    const candidate = realpathSafe(path.resolve(root, clean));
    if (!within(candidate, root)) {
      throw new PathGuardError(`path escapes repo: ${relPath}`);
    }
    return candidate;
  }

  return { base: realBase, repoRoot, resolveInRepo };
}

/** 全域 guard:basePath 取自 env PORTHOLE_BASE,否則 DEFAULT_BASE。 */
export const guard: Guard = createGuard(process.env.PORTHOLE_BASE ?? DEFAULT_BASE);
