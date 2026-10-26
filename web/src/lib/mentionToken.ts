/**
 * mentionToken — composer mention 的觸發偵測(純邏輯,好測)。SPEC §4.2「composer mention」。
 *
 *  - `@` → **tag agent**:agent = basePath 下的兄弟 repo(相對當前 repo 就是 `../*`)。
 *  - `.` → **叫檔案**:repo 相對路徑,插入成 `./doc/foo.md`(claude -p 的 CWD = repo root)。
 *
 * 兩者都要在行首或空白後才算(`foo.md`、`a@b` 這種字中間的不觸發)。
 */
export type MentionKind = 'agent' | 'file';

export interface MentionToken {
  kind: MentionKind;
  /** value 中觸發字元(`@` / `.`)的索引。 */
  at: number;
  /** 觸發字元到游標的原文長度(含觸發字元),替換時用。 */
  len: number;
  /**
   * agent:`@` 之後的字。
   * file:repo 相對的查詢路徑(`./doc/fo` → `doc/fo`;`.cl` → `.cl`,即根目錄下 dotfile)。
   */
  query: string;
}

/** 偵測游標前是否正在打 mention token。 */
export function detectMention(value: string, cursor: number): MentionToken | null {
  const head = value.slice(0, cursor);
  const a = /(?:^|\s)@([^\s@]*)$/.exec(head);
  if (a) return { kind: 'agent', at: cursor - a[1].length - 1, len: a[1].length + 1, query: a[1] };
  const f = /(?:^|\s)(\.[^\s@]*)$/.exec(head);
  if (f) {
    const tok = f[1];
    const query = tok === '.' ? '' : tok.startsWith('./') ? tok.slice(2) : tok;
    return { kind: 'file', at: cursor - tok.length, len: tok.length, query };
  }
  return null;
}

/** file query → 要列的目錄(相對 repo root)+ 用來過濾的 prefix。 */
export function splitFileQuery(query: string): { dir: string; prefix: string } {
  const slash = query.lastIndexOf('/');
  if (slash === -1) return { dir: '.', prefix: query };
  return { dir: query.slice(0, slash) || '.', prefix: query.slice(slash + 1) };
}

/** 檔案 mention 插入的文字:`./<repo 相對路徑>`。 */
export function fileMentionText(rel: string): string {
  return `./${rel}`;
}
