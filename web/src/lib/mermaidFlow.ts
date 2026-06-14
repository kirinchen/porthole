/**
 * mermaidFlow — mermaid flowchart 子集 的解析 / 序列化 + 區塊取代。
 *
 * 子集:節點(矩形)+ 有向邊(`-->`)+ 邊標籤(`-->|label|`)+ 方向(TD/TB/BT/LR/RL)。
 * 不支援:subgraph、各種形狀、classDef 樣式 —— 這些超出子集,GUI 不處理(退回純文字編輯)。
 * GUI 存檔走 serializeFlow → 正規化重寫該 mermaid 區塊(註解 / 手動排版 / 樣式會丟,已與使用者確認)。
 */

export type FlowShape = 'rect' | 'round' | 'diamond';
export interface FlowNode {
  id: string;
  label: string;
  shape: FlowShape; // [] 矩形 / () 圓角 / {} 菱形(判斷)
}
export interface FlowEdge {
  source: string;
  target: string;
  label?: string;
}
export interface FlowGraph {
  dir: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const DIRS = new Set(['TB', 'TD', 'BT', 'LR', 'RL']);

/** 是否為 flowchart(graph / flowchart 開頭)。 */
export function isFlowchart(code: string): boolean {
  return /^\s*(graph|flowchart)\b/i.test(code);
}

/** 抓節點規格:`id` / `id[label]`(矩形) / `id(label)`(圓角) / `id{label}`(菱形)。回傳 id。 */
function parseNodeSpec(
  p: string,
  ensure: (id: string, label?: string, shape?: FlowShape) => void,
): string {
  const s = p.trim();
  if (!s) return '';
  const m = /^([^\s[\](){}]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/.exec(s);
  if (!m) {
    ensure(s);
    return s;
  }
  const id = m[1];
  let label: string | undefined;
  let shape: FlowShape | undefined;
  if (m[2] !== undefined) {
    label = m[2];
    shape = 'rect';
  } else if (m[3] !== undefined) {
    label = m[3];
    shape = 'round';
  } else if (m[4] !== undefined) {
    label = m[4];
    shape = 'diamond';
  }
  if (label !== undefined) {
    label = label.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  }
  ensure(id, label, shape);
  return id;
}

// 箭頭(含可選 |label|);長/帶 > 的形式排前面,避免被短形式先吃掉。
const ARROW = /(?:-->|==>|-\.->|--x|--o|---|===|--|==)(?:\|([^|]*)\|)?/g;

function parseStatement(
  stmt: string,
  ensure: (id: string, label?: string, shape?: FlowShape) => void,
  edges: FlowEdge[],
): void {
  const parts: string[] = [];
  const labels: (string | undefined)[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  ARROW.lastIndex = 0;
  let hasArrow = false;
  while ((m = ARROW.exec(stmt)) !== null) {
    hasArrow = true;
    parts.push(stmt.slice(last, m.index));
    labels.push(m[1]);
    last = m.index + m[0].length;
  }
  parts.push(stmt.slice(last));
  const ids = parts.map((p) => parseNodeSpec(p, ensure)).filter(Boolean);
  if (!hasArrow) return; // 純節點宣告,parseNodeSpec 已登記
  for (let i = 0; i + 1 < ids.length; i++) {
    const label = labels[i]?.trim();
    edges.push({ source: ids[i], target: ids[i + 1], label: label || undefined });
  }
}

/** 解析 flowchart 子集 → 圖模型。無法解析的語法盡量略過,不丟例外。 */
export function parseFlow(code: string): FlowGraph {
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));

  let dir = 'TD';
  let start = 0;
  if (lines.length && /^(graph|flowchart)\b/i.test(lines[0])) {
    const h = /^(?:graph|flowchart)\s+([A-Za-z]{2})\b/i.exec(lines[0]);
    if (h && DIRS.has(h[1].toUpperCase())) dir = h[1].toUpperCase();
    start = 1;
  }

  const nodes = new Map<string, FlowNode>();
  const ensure = (id: string, label?: string, shape?: FlowShape) => {
    const ex = nodes.get(id);
    if (ex) {
      if (label !== undefined) ex.label = label;
      if (shape) ex.shape = shape;
      return;
    }
    nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect' });
  };
  const edges: FlowEdge[] = [];

  for (let i = start; i < lines.length; i++) {
    for (const stmt of lines[i].split(';')) {
      if (stmt.trim()) parseStatement(stmt, ensure, edges);
    }
  }
  return { dir, nodes: [...nodes.values()], edges };
}

function escapeLabel(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/** 圖模型 → 正規化 mermaid flowchart 文字。 */
export function serializeFlow(g: FlowGraph): string {
  const dir = DIRS.has(g.dir) ? g.dir : 'TD';
  const lines = [`flowchart ${dir}`];
  for (const n of g.nodes) {
    const shape = n.shape ?? 'rect';
    if (shape === 'rect') {
      if (n.label && n.label !== n.id) lines.push(`    ${n.id}["${escapeLabel(n.label)}"]`);
      else lines.push(`    ${n.id}`);
    } else {
      const [open, close] = shape === 'diamond' ? ['{', '}'] : ['(', ')'];
      lines.push(`    ${n.id}${open}"${escapeLabel(n.label || n.id)}"${close}`);
    }
  }
  for (const e of g.edges) {
    if (e.label) lines.push(`    ${e.source} -->|${e.label}| ${e.target}`);
    else lines.push(`    ${e.source} --> ${e.target}`);
  }
  return lines.join('\n');
}

/** 把 content 內某個 ```mermaid 區塊(body 與 oldCode 相符)換成 newCode。 */
export function replaceMermaidBlock(content: string, oldCode: string, newCode: string): string {
  const re = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1].trim() === oldCode.trim()) {
      return (
        content.slice(0, m.index) +
        '```mermaid\n' +
        newCode +
        '\n```' +
        content.slice(m.index + m[0].length)
      );
    }
  }
  return content.replace(oldCode, newCode); // fallback
}
