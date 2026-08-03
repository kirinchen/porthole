/**
 * mdTable — GFM 表格 的解析 / 序列化(供 TableBlock GUI 編輯器)。
 *
 * 子集:標準 GFM pipe table —— header 列 + 分隔列(`| --- | :-: | ---: |`)+ 資料列。
 *  - 首尾 `|` 皆可有可無;cell 內 `\|` = 逸出的字面 `|`。
 *  - 模型 cell 存「邏輯內容」(去頭尾空白、`\|` 已還原成 `|`);序列化時再逸出 / 補寬對齊。
 *  - cell 為單行(GUI 用 <input>);換行請用 `<br>`(序列化保留字面 `<br>`)。
 */

export type Align = 'none' | 'left' | 'center' | 'right';

export interface TableModel {
  headers: string[];
  aligns: Align[]; // 長度 = headers.length
  rows: string[][]; // 每列長度已正規化 = headers.length
}

/** 分隔列的單一 cell 是否為對齊標記(`:?-+:?`)。 */
function isDelimCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

/** 一列切成 cells:處理 `\|` 逸出、去掉首尾 pipe 造成的空欄。回傳「未 trim」的原始 cell 段。 */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|'; // 逸出的 pipe → 字面 |
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  const s = line.trim();
  if (cells.length && s.startsWith('|')) cells.shift(); // 首 pipe 造成的前導空欄
  if (cells.length && s.endsWith('|')) cells.pop(); // 尾 pipe 造成的尾隨空欄
  return cells;
}

/** 一列 → 已 trim 的 cell 陣列。 */
function splitRow(line: string): string[] {
  return splitCells(line).map((c) => c.trim());
}

function parseAlign(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return 'none';
}

/** 是否為 GFM 表格(至少 header + 合法分隔列)。 */
export function isTable(src: string): boolean {
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const delim = splitRow(lines[1]);
  return delim.length > 0 && delim.every(isDelimCell);
}

/** 解析 GFM 表格 → 模型。非表格回 null。 */
export function parseTable(src: string): TableModel | null {
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const delimCells = splitRow(lines[1]);
  if (!delimCells.length || !delimCells.every(isDelimCell)) return null;

  const headers = splitRow(lines[0]);
  const ncol = headers.length;
  const aligns: Align[] = Array.from({ length: ncol }, (_, i) =>
    i < delimCells.length ? parseAlign(delimCells[i]) : 'none',
  );
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    return Array.from({ length: ncol }, (_, i) => cells[i] ?? '');
  });
  return { headers, aligns, rows };
}

/** cell 序列化逸出:字面 `|` → `\|`;換行 → `<br>`(cell 為單行,防禦性處理)。 */
function escCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function pad(s: string, w: number, align: Align): string {
  const gap = w - s.length;
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap); // left / none
}

function delimStr(align: Align, w: number): string {
  const width = Math.max(w, align === 'center' ? 3 : align === 'none' ? 1 : 2);
  switch (align) {
    case 'left':
      return ':' + '-'.repeat(width - 1);
    case 'right':
      return '-'.repeat(width - 1) + ':';
    case 'center':
      return ':' + '-'.repeat(width - 2) + ':';
    default:
      return '-'.repeat(width);
  }
}

/** 模型 → 正規化 GFM 表格文字(逐欄補寬對齊,分隔列最小寬 3)。 */
export function serializeTable(m: TableModel): string {
  const ncol = m.headers.length;
  const esc = {
    headers: m.headers.map(escCell),
    rows: m.rows.map((r) => Array.from({ length: ncol }, (_, i) => escCell(r[i] ?? ''))),
  };
  // 逐欄寬度:header / 各 cell 的最大字元數,下限 3(供分隔列 `---`)。
  const widths = Array.from({ length: ncol }, (_, i) => {
    let w = Math.max(3, esc.headers[i]?.length ?? 0);
    for (const r of esc.rows) w = Math.max(w, r[i]?.length ?? 0);
    return w;
  });
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => pad(c, widths[i], m.aligns[i] ?? 'none')).join(' | ') + ' |';

  const out = [
    line(esc.headers),
    '| ' + m.aligns.map((a, i) => delimStr(a ?? 'none', widths[i])).join(' | ') + ' |',
    ...esc.rows.map((r) => line(r)),
  ];
  return out.join('\n');
}

/** 兩模型是否等價(cell 以 trim 後比較 —— 忽略打字中暫存的頭尾空白,避免受控 input 被回寫清掉)。 */
export function tableModelEqual(a: TableModel, b: TableModel): boolean {
  if (a.headers.length !== b.headers.length) return false;
  if (a.rows.length !== b.rows.length) return false;
  const eqCell = (x: string, y: string) => x.trim() === y.trim();
  if (!a.headers.every((h, i) => eqCell(h, b.headers[i]))) return false;
  if (!a.aligns.every((al, i) => al === b.aligns[i])) return false;
  return a.rows.every((r, i) => r.length === b.rows[i].length && r.every((c, j) => eqCell(c, b.rows[i][j])));
}

/** 空白起手表格(2 欄 x 1 資料列)。 */
export function emptyTable(): TableModel {
  return { headers: ['欄位 1', '欄位 2'], aligns: ['none', 'none'], rows: [['', '']] };
}
