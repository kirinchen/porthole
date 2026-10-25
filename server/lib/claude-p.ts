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
 * `claude` 吃的 model / effort 白名單(見 `claude --help`)。
 * 走白名單而不是原樣轉送:argv 不經 shell 已擋掉注入,但也不該把任意字串當 flag 丟給 CLI
 * (打錯一個值整趟就起不來)。前端的 ⚙ 下拉直接讀 `GET /api/chat/engine` 拿這兩張表。
 */
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface RunOpts {
  /**
   * YOLO:加 --dangerously-skip-permissions,讓 agent 能無提示執行工具
   * (讀寫檔、跑指令…)。安全邊界靠 CWD 的 path-guard(已鎖在 basePath 內),不靠 prompt。
   */
  yolo?: boolean;
  /** `--model`(留空 = 用 CLI 自己的預設)。值須在 MODELS 內,呼叫端負責驗。 */
  model?: string;
  /** `--effort`。值須在 EFFORTS 內。 */
  effort?: string;
}

/**
 * 跑 `claude -p <prompt>`,CWD = cwd。
 * prompt 走 argv(不經 shell),避免注入。
 */
export function runClaude(prompt: string, cwd: string, opts: RunOpts = {}): ClaudeRun {
  const chunkCbs: Array<(t: string) => void> = [];
  const errCbs: Array<(t: string) => void> = [];
  const endCbs: Array<(c: number | null) => void> = [];

  const args = ['-p'];
  if (opts.yolo) args.push('--dangerously-skip-permissions');
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  args.push(prompt);

  const child = spawn('claude', args, {
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
