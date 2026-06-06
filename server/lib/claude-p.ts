/**
 * claude-p — 把 `claude -p` 當 Unix tool 用(SPEC §1 LLM as Unix tool)。
 * stdin → stdout 子程序,CWD = repo root(已過 path-guard)。不整合任何 SDK。
 */
import { spawn } from 'node:child_process';

export interface ClaudeRun {
  /** child 的 stdout chunk(逐字)。 */
  onChunk: (cb: (text: string) => void) => void;
  /** stderr 文字。 */
  onError: (cb: (text: string) => void) => void;
  /** 結束(code = exit code,null = 被 kill)。 */
  onEnd: (cb: (code: number | null) => void) => void;
  /** 中止子程序。 */
  abort: () => void;
}

/**
 * 跑 `claude -p <prompt>`,CWD = cwd。
 * prompt 走 argv(不經 shell),避免注入。
 */
export function runClaude(prompt: string, cwd: string): ClaudeRun {
  const chunkCbs: Array<(t: string) => void> = [];
  const errCbs: Array<(t: string) => void> = [];
  const endCbs: Array<(c: number | null) => void> = [];

  const child = spawn('claude', ['-p', prompt], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => chunkCbs.forEach((cb) => cb(d)));
  child.stderr.on('data', (d: string) => errCbs.forEach((cb) => cb(d)));
  child.on('error', (e) => errCbs.forEach((cb) => cb(String(e))));
  child.on('close', (code) => endCbs.forEach((cb) => cb(code)));

  return {
    onChunk: (cb) => chunkCbs.push(cb),
    onError: (cb) => errCbs.push(cb),
    onEnd: (cb) => endCbs.push(cb),
    abort: () => child.kill('SIGTERM'),
  };
}
