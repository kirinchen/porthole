/**
 * tmux — Session tab 的背景生命週期管理。
 *
 * 設計(SPEC §9 細設,Kelp 驗收):
 *  - claude session 列舉走「讀檔」而非互動式 `claude -r`(deterministic-first):
 *    claude 把每個 session 存成 `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`,
 *    encoded-cwd = repoRoot 把 `/` 換成 `-`。一個 jsonl = 一個可恢復 session。
 *  - 點某 session → 開/接一個 tmux session 在背景跑 `claude --resume <id>`:
 *      命名:porthole_<repo>_<id8>  (只留 [A-Za-z0-9_],tmux 安全)
 *      建立:tmux new-session -d -s <name> -c <repoRoot> 'claude --resume <id>'
 *      列出:tmux list-sessions 篩 porthole_ 前綴
 *      attach:routes/session.ts 用 node-pty spawn `tmux attach -t <name>`,
 *             WS 關閉 = detach(client 斷線),tmux session 仍在背景續跑
 *      收掉:tmux kill-session -t <name>
 *  - 生命週期:建立後 detach 仍活;由使用者顯式 kill,或機器重開時自然消失。
 *    porthole 不自動收 session(背景續跑是這 tab 的目的)。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const pexec = promisify(execFile);

export interface ClaudeSession {
  id: string;
  /** 最後修改時間(epoch ms),供前端排序。 */
  mtime: number;
  /** 第一則 user 訊息摘要(截斷),當標題。 */
  title: string;
}

function encodeProjectDir(repoRoot: string): string {
  // claude 的編碼:把路徑分隔字元換成 '-'(含開頭斜線 → 開頭也是 '-')。
  return repoRoot.replace(/[/\\]/g, '-');
}

/** 列該 repo 可恢復的 claude session(讀 ~/.claude/projects/<encoded>/)。 */
export async function listClaudeSessions(repoRoot: string): Promise<ClaudeSession[]> {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(repoRoot));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // 沒有任何 session
  }
  const out: ClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    const id = name.slice(0, -'.jsonl'.length);
    let mtime = 0;
    let title = '';
    try {
      const st = await fs.stat(full);
      mtime = st.mtimeMs;
      title = await firstUserText(full);
    } catch {
      /* 壞檔略過摘要 */
    }
    out.push({ id, mtime, title });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 刪除某 claude session 的 jsonl 記錄(~/.claude/projects/<encoded>/<id>.jsonl)。
 *  id 嚴格驗證(僅 [A-Za-z0-9_-],無 . / →無路徑穿越)。 */
export async function deleteClaudeSession(repoRoot: string, id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw Object.assign(new Error('invalid session id'), { statusCode: 400 });
  }
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(repoRoot));
  await fs.rm(path.join(dir, `${id}.jsonl`), { force: false });
}

/** 讀 jsonl 找第一則 user 文字訊息(截斷 80 字)當標題。 */
async function firstUserText(file: string): Promise<string> {
  const raw = await fs.readFile(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msg = obj?.message;
      if (msg?.role === 'user') {
        const content = msg.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          text = content
            .filter((c: { type?: string }) => c?.type === 'text')
            .map((c: { text?: string }) => c.text ?? '')
            .join(' ');
        }
        text = text.trim().replace(/\s+/g, ' ');
        if (text) return text.slice(0, 80);
      }
    } catch {
      /* 跳過壞行 */
    }
  }
  return '(無標題)';
}

/** porthole 的 tmux session 命名(tmux 安全字元)。 */
export function tmuxName(repo: string, sessionId: string): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9_]/g, '_');
  const safeId = sessionId.replace(/[^A-Za-z0-9_]/g, '').slice(0, 8);
  return `porthole_${safeRepo}_${safeId}`;
}

/** tmux 中是否已有此 session。 */
export async function tmuxExists(name: string): Promise<boolean> {
  try {
    await pexec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

/** 全新背景 session 的 tmux 名(無 claude session id → 用時間戳,仍合白名單)。 */
export function newTmuxName(repo: string): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9_]/g, '_');
  return `porthole_${safeRepo}_new${Date.now()}`;
}

/** 設 session 友善選項:mouse on(滾輪進 copy-mode 捲歷史)+ set-clipboard on
 *  (tmux 在 yank 時 emit OSC 52,前端 osc52 handler 轉本機剪貼簿)。 */
export async function enableMouse(name: string): Promise<void> {
  try {
    await pexec('tmux', ['set-option', '-t', name, 'mouse', 'on']);
  } catch {
    /* 開不起來不影響 session 本身 */
  }
  try {
    await pexec('tmux', ['set-option', '-g', 'set-clipboard', 'on']);
  } catch {
    /* 同上 */
  }
}

/** 開全新背景 tmux 跑指定指令(command 為已拆好的 argv,如 ['claude','--model','x'])。
 *  走 execFile argv、不經 shell(故無 shell 注入);與 CLI 同屬信任網路下的 RCE 面。 */
export async function startFreshTmux(name: string, cwd: string, command: string[]): Promise<void> {
  await pexec('tmux', ['new-session', '-d', '-s', name, '-c', cwd, ...command]);
  await enableMouse(name);
}

/** 確保背景 tmux session 存在;不存在則建立並在內跑 `claude --resume <id> [extra…]`。
 *  已存在則直接 return(不會用新參數重建 → 接既有 session)。extra 走 argv,不經 shell。 */
export async function ensureTmux(
  name: string,
  cwd: string,
  claudeSessionId: string,
  extra: string[] = [],
): Promise<void> {
  if (await tmuxExists(name)) return;
  await pexec('tmux', [
    'new-session',
    '-d',
    '-s',
    name,
    '-c',
    cwd,
    'claude',
    '--resume',
    claudeSessionId,
    ...extra,
  ]);
  await enableMouse(name);
}

/** 列出 porthole 開的 tmux session 名稱。 */
export async function listTmux(): Promise<string[]> {
  try {
    const { stdout } = await pexec('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('porthole_'));
  } catch {
    return []; // 沒有 tmux server / 沒有 session
  }
}

/** 收掉一個 tmux session。 */
export async function killTmux(name: string): Promise<void> {
  await pexec('tmux', ['kill-session', '-t', name]);
}
