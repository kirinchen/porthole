/**
 * ArchitectureEditor — mermaid architecture-beta(Architecture Diagram)子集 的 GUI 編輯器
 * (React Flow + dagre 近似排版)。
 *  - 解析 mermaid → service(四邊接點)/ group(parent 節點)/ junction(小圓點)/ 邊。
 *  - double-click service/group → 改 id / title / icon / 所屬 group;double-click 邊 → 改側邊 / 箭頭 / 刪。
 *  - 拖把手連線 → 新增邊(預設無箭頭,側邊取拖出的 handle);Delete 刪選取;按鈕新增 service / group。
 *  - 「套用」→ serializeArchitecture → onSave(正規化 mermaid 文字);「取消」→ onClose。
 *  畫布排版僅近似(mermaid 預覽會自行排版),序列化正確最重要。
 *  本元件較重(React Flow + dagre)→ 由上層以 lazy + Suspense 載入。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { Button, Modal, Input, Select, Space, Typography, message } from 'antd';
import {
  PlusOutlined,
  UndoOutlined,
  RedoOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import {
  parseArchitecture,
  serializeArchitecture,
  iconEmoji,
  type Side,
  type ArchModel,
  type ArchGroup,
  type ArchService,
  type ArchJunction,
  type ArchEdge,
} from '../lib/mermaidArchitecture';

const SIDE_OPTS: { value: Side; label: string }[] = [
  { value: 'L', label: 'L (左)' },
  { value: 'R', label: 'R (右)' },
  { value: 'T', label: 'T (上)' },
  { value: 'B', label: 'B (下)' },
];

// 箭頭方向(arrowFrom / arrowTo 組合)。
type ArrowKind = 'none' | 'to' | 'from' | 'both';
const ARROW_OPTS: { value: ArrowKind; label: string }[] = [
  { value: 'none', label: '無 (--)' },
  { value: 'to', label: '指向終點 (-->)' },
  { value: 'from', label: '指向起點 (<--)' },
  { value: 'both', label: '雙向 (<-->)' },
];

// 內建 icon 選項(其餘可手填 iconify 名稱)。
const BUILTIN_ICONS = ['cloud', 'database', 'disk', 'internet', 'server'];

const SVC_W = 120;
const SVC_H = 64;

/** Side → React Flow Position。 */
function sidePos(s: Side): Position {
  switch (s) {
    case 'L':
      return Position.Left;
    case 'R':
      return Position.Right;
    case 'T':
      return Position.Top;
    case 'B':
      return Position.Bottom;
  }
}

/** arrowFrom / arrowTo ↔ ArrowKind 互轉。 */
function toArrowKind(arrowFrom: boolean, arrowTo: boolean): ArrowKind {
  if (arrowFrom && arrowTo) return 'both';
  if (arrowTo) return 'to';
  if (arrowFrom) return 'from';
  return 'none';
}
function fromArrowKind(k: ArrowKind): { arrowFrom: boolean; arrowTo: boolean } {
  return {
    arrowFrom: k === 'from' || k === 'both',
    arrowTo: k === 'to' || k === 'both',
  };
}

/** 自訂節點:service = 方塊(icon emoji / 名稱 + title);四邊各有 source+target Handle。 */
function ServiceNode({ data }: NodeProps) {
  const d = data as { title?: string; icon?: string; nid?: string };
  const emoji = iconEmoji(d.icon);
  const sides: Side[] = ['L', 'R', 'T', 'B'];
  return (
    <div
      style={{
        position: 'relative',
        width: SVC_W,
        height: SVC_H,
        border: '1px solid #555',
        borderRadius: 6,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        gap: 2,
        boxSizing: 'border-box',
        padding: '0 6px',
      }}
    >
      <div style={{ fontSize: emoji ? 22 : 12, lineHeight: 1 }}>
        {emoji ?? d.icon ?? ''}
      </div>
      <div
        style={{
          maxWidth: '100%',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontWeight: 600,
        }}
      >
        {d.title || d.nid}
      </div>
      {sides.map((s) => (
        <span key={s}>
          <Handle
            id={`t-${s}`}
            type="target"
            position={sidePos(s)}
            style={{ background: '#555' }}
          />
          <Handle
            id={`s-${s}`}
            type="source"
            position={sidePos(s)}
            style={{ background: '#555' }}
          />
        </span>
      ))}
    </div>
  );
}

/** 自訂節點:junction = 小圓點;四邊各有 source+target Handle。 */
function JunctionNode() {
  const sides: Side[] = ['L', 'R', 'T', 'B'];
  return (
    <div
      style={{
        position: 'relative',
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#888',
        border: '1px solid #555',
      }}
    >
      {sides.map((s) => (
        <span key={s}>
          <Handle id={`t-${s}`} type="target" position={sidePos(s)} style={{ background: '#555' }} />
          <Handle id={`s-${s}`} type="source" position={sidePos(s)} style={{ background: '#555' }} />
        </span>
      ))}
    </div>
  );
}

/** 自訂節點:group = 標題框(React Flow parent 容器)。 */
function GroupNode({ data }: NodeProps) {
  const d = data as { title?: string; icon?: string; nid?: string };
  const emoji = iconEmoji(d.icon);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        border: '1px dashed #888',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.02)',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 8,
          fontSize: 12,
          fontWeight: 600,
          color: '#555',
          pointerEvents: 'none',
        }}
      >
        {emoji ? `${emoji} ` : ''}
        {d.title || d.nid}
      </div>
    </div>
  );
}

interface Props {
  code: string;
  onSave: (code: string) => void;
  onClose: () => void;
  /** 滿版模式:撐滿父容器高度(由上層的全螢幕切換帶入)。 */
  fill?: boolean;
}

type Snap = { nodes: Node[]; edges: Edge[] };

const GROUP_PAD = 40;

/** edge.data:邊的結構化欄位(端點為 group 由節點 type 判定,不存於此)。 */
type EdgeData = {
  fromSide: Side;
  toSide: Side;
  arrowFrom: boolean;
  arrowTo: boolean;
};

/** 由 sourceHandle / targetHandle id(如 "s-R" / "t-L")取側邊。 */
function handleSide(h: string | null | undefined, fallback: Side): Side {
  if (!h) return fallback;
  const c = h.slice(-1).toUpperCase();
  return c === 'L' || c === 'R' || c === 'T' || c === 'B' ? (c as Side) : fallback;
}

/** dagre 近似排版(僅排無 parent 的頂層節點;group 子節點以相對座標另算)。 */
function layout(nodes: Node[], edges: Edge[]): Node[] {
  const top = nodes.filter((n) => !n.parentId);
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  top.forEach((n) => {
    const w = typeof n.style?.width === 'number' ? n.style.width : SVC_W;
    const h = typeof n.style?.height === 'number' ? n.style.height : SVC_H;
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach((e) => {
    if (top.some((n) => n.id === e.source) && top.some((n) => n.id === e.target)) {
      g.setEdge(e.source, e.target);
    }
  });
  dagre.layout(g);
  return nodes.map((n) => {
    if (n.parentId) return n; // 子節點維持相對座標
    const p = g.node(n.id);
    if (!p) return n;
    const w = typeof n.style?.width === 'number' ? n.style.width : SVC_W;
    const h = typeof n.style?.height === 'number' ? n.style.height : SVC_H;
    return { ...n, position: { x: p.x - w / 2, y: p.y - h / 2 } };
  });
}

export default function ArchitectureEditor({ code, onSave, onClose, fill }: Props) {
  const nodeTypes = useMemo(
    () => ({
      service: ServiceNode,
      junction: JunctionNode,
      archGroup: GroupNode,
    }),
    [],
  );

  const init = useMemo(() => {
    const model = parseArchitecture(code);

    // group 容器:估算大小,以容納其子節點(近似;mermaid 會自行排版)。
    const childCount = new Map<string, number>();
    for (const s of model.services) if (s.group) childCount.set(s.group, (childCount.get(s.group) ?? 0) + 1);
    for (const j of model.junctions) if (j.group) childCount.set(j.group, (childCount.get(j.group) ?? 0) + 1);

    const groupNodes: Node[] = model.groups.map((gp) => {
      const cnt = childCount.get(gp.id) ?? 0;
      const cols = Math.max(1, Math.ceil(Math.sqrt(cnt)));
      const rows = Math.max(1, Math.ceil(cnt / cols));
      return {
        id: gp.id,
        type: 'archGroup',
        data: { nid: gp.id, title: gp.title, icon: gp.icon },
        position: { x: 0, y: 0 },
        ...(gp.parent ? { parentId: gp.parent, extent: 'parent' as const } : {}),
        style: {
          width: cols * (SVC_W + 24) + GROUP_PAD,
          height: rows * (SVC_H + 24) + GROUP_PAD + 16,
        },
      };
    });

    // service / junction:若屬某 group → parentId + 相對座標(網格鋪排)。
    const placedInGroup = new Map<string, number>();
    const childPos = (group: string) => {
      const idx = placedInGroup.get(group) ?? 0;
      placedInGroup.set(group, idx + 1);
      const cols = Math.max(1, Math.ceil(Math.sqrt(childCount.get(group) ?? 1)));
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      return { x: GROUP_PAD / 2 + col * (SVC_W + 24), y: GROUP_PAD + row * (SVC_H + 24) };
    };

    const svcNodes: Node[] = model.services.map((s) => ({
      id: s.id,
      type: 'service',
      data: { nid: s.id, title: s.title, icon: s.icon },
      position: s.group ? childPos(s.group) : { x: 0, y: 0 },
      style: { width: SVC_W, height: SVC_H },
      ...(s.group ? { parentId: s.group, extent: 'parent' as const } : {}),
    }));

    const juncNodes: Node[] = model.junctions.map((j) => ({
      id: j.id,
      type: 'junction',
      data: { nid: j.id },
      position: j.group ? childPos(j.group) : { x: 0, y: 0 },
      ...(j.group ? { parentId: j.group, extent: 'parent' as const } : {}),
    }));

    const es: Edge[] = model.edges.map((e, i) => {
      const data: EdgeData = {
        fromSide: e.fromSide,
        toSide: e.toSide,
        arrowFrom: e.arrowFrom,
        arrowTo: e.arrowTo,
      };
      return {
        id: `a${i}-${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        sourceHandle: `s-${e.fromSide}`,
        targetHandle: `t-${e.toSide}`,
        markerStart: e.arrowFrom ? { type: MarkerType.ArrowClosed } : undefined,
        markerEnd: e.arrowTo ? { type: MarkerType.ArrowClosed } : undefined,
        data,
      };
    });

    // parent 節點需排在子節點之前(React Flow 要求)。巢狀 group 須依
    // parent 依賴做 topological sort:無父者在前,子在後。
    const groupById = new Map(groupNodes.map((n) => [n.id, n]));
    const sortedGroups: Node[] = [];
    const seenG = new Set<string>();
    const visit = (n: Node) => {
      if (seenG.has(n.id)) return;
      seenG.add(n.id);
      const parent = n.parentId ? groupById.get(String(n.parentId)) : undefined;
      if (parent) visit(parent); // 父 group 先入列
      sortedGroups.push(n);
    };
    for (const n of groupNodes) visit(n);

    // group(已排序,父在子前)→ service / junction(子一律在 parent 之後)。
    const allNodes = [...sortedGroups, ...svcNodes, ...juncNodes];
    return { nodes: layout(allNodes, es), edges: es };
  }, [code]);

  const [nodes, setNodes] = useState<Node[]>(init.nodes);
  const [edges, setEdges] = useState<Edge[]>(init.edges);
  const [seq, setSeq] = useState(1);

  // 雙擊編輯:node(service/group/junction)/ edge。
  const [editNode, setEditNode] = useState<{
    id: string;
    kind: 'service' | 'archGroup' | 'junction';
    nid: string;
    title: string;
    icon: string;
    group: string; // service/junction 的所屬 group;group 的 parent
  } | null>(null);
  const [editEdge, setEditEdge] = useState<{
    id: string;
    fromSide: Side;
    toSide: Side;
    arrow: ArrowKind;
  } | null>(null);
  const [adding, setAdding] = useState<{ kind: 'service' | 'archGroup'; id: string } | null>(null);

  // 復原 / 重做:快照堆疊;copy/paste:剪貼簿 ref。
  const [past, setPast] = useState<Snap[]>([]);
  const [future, setFuture] = useState<Snap[]>([]);
  const clipboard = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);

  const takeSnapshot = useCallback(() => {
    setPast((p) => [...p.slice(-49), { nodes, edges }]);
    setFuture([]);
  }, [nodes, edges]);

  const undo = useCallback(() => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setFuture((f) => [{ nodes, edges }, ...f]);
    setPast((p) => p.slice(0, -1));
    setNodes(prev.nodes);
    setEdges(prev.edges);
  }, [past, nodes, edges]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = future[0];
    setPast((p) => [...p, { nodes, edges }]);
    setFuture((f) => f.slice(1));
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [future, nodes, edges]);

  const copy = useCallback(() => {
    // 只複製 service / junction(group 容器牽連子節點,跳過)。
    const sel = nodes.filter((n) => n.selected && n.type !== 'archGroup');
    if (!sel.length) return;
    const ids = new Set(sel.map((n) => n.id));
    clipboard.current = {
      nodes: sel,
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
  }, [nodes, edges]);

  const paste = useCallback(() => {
    const clip = clipboard.current;
    if (!clip?.nodes.length) return;
    takeSnapshot();
    let s = seq;
    const used = new Set(nodes.map((n) => n.id));
    const idMap = new Map<string, string>();
    const newNodes = clip.nodes.map((n) => {
      const base = String((n.data as { nid?: string }).nid ?? n.id);
      let nid = `${base}_${s++}`;
      while (used.has(nid)) nid = `${base}_${s++}`;
      used.add(nid);
      idMap.set(n.id, nid);
      // 貼上時脫離 group(避免相對座標 / parent 失配)。
      const { parentId: _p, extent: _e, ...rest } = n;
      void _p;
      void _e;
      return {
        ...rest,
        id: nid,
        position: { x: n.position.x + 32, y: n.position.y + 32 },
        selected: true,
        data: { ...n.data, nid },
      } as Node;
    });
    const newEdges = clip.edges.flatMap((e, i) => {
      const source = idMap.get(e.source);
      const target = idMap.get(e.target);
      if (source === undefined || target === undefined) return [];
      // 明確保留 edge.data(fromSide/toSide/箭頭等),複製一份避免共用參照。
      const data = e.data ? { ...e.data } : undefined;
      return [{ ...e, id: `a-paste-${s}-${i}`, source, target, selected: false, data }];
    });
    setSeq(s);
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...newNodes]);
    setEdges((es) => [...es, ...newEdges]);
  }, [nodes, edges, seq, takeSnapshot]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (k === 'c') {
        e.preventDefault();
        copy();
      } else if (k === 'v') {
        e.preventDefault();
        paste();
      }
    },
    [undo, redo, copy, paste],
  );

  const onNodesChange = useCallback(
    (c: NodeChange[]) => {
      if (c.some((x) => x.type === 'remove')) takeSnapshot();
      setNodes((n) => applyNodeChanges(c, n));
    },
    [takeSnapshot],
  );
  const onEdgesChange = useCallback(
    (c: EdgeChange[]) => {
      if (c.some((x) => x.type === 'remove')) takeSnapshot();
      setEdges((e) => applyEdgeChanges(c, e));
    },
    [takeSnapshot],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      takeSnapshot();
      // 新邊預設無箭頭;側邊取拖出 / 落下的 handle。
      const fromSide = handleSide(c.sourceHandle, 'R');
      const toSide = handleSide(c.targetHandle, 'L');
      const data: EdgeData = { fromSide, toSide, arrowFrom: false, arrowTo: false };
      setEdges((e) =>
        addEdge(
          {
            ...c,
            id: `a-${c.source}-${c.target}-${e.length}`,
            sourceHandle: `s-${fromSide}`,
            targetHandle: `t-${toSide}`,
            data,
          },
          e,
        ),
      );
    },
    [takeSnapshot],
  );

  const reLayout = () => setNodes((n) => layout(n, edges));

  // 新增 service / group。
  const doAdd = () => {
    if (!adding) return;
    const id = adding.id.trim();
    if (!id) return;
    if (nodes.some((n) => n.id === id)) {
      message.error(`id「${id}」已存在`);
      return;
    }
    takeSnapshot();
    if (adding.kind === 'archGroup') {
      setNodes((n) => [
        {
          id,
          type: 'archGroup',
          data: { nid: id, title: '', icon: '' },
          position: { x: 40, y: 40 },
          style: { width: SVC_W + GROUP_PAD, height: SVC_H + GROUP_PAD + 16 },
        },
        ...n,
      ]);
    } else {
      setNodes((n) => [
        ...n,
        {
          id,
          type: 'service',
          data: { nid: id, title: '', icon: '' },
          position: { x: 60, y: 60 },
          style: { width: SVC_W, height: SVC_H },
        },
      ]);
    }
    setAdding(null);
  };

  const applyNode = () => {
    if (!editNode) return;
    const newId = editNode.nid.trim() || editNode.id;
    if (newId !== editNode.id && nodes.some((n) => n.id === newId)) {
      message.error(`id「${newId}」已存在`);
      return;
    }
    takeSnapshot();
    const oldId = editNode.id;
    // 設 parentId 前確認該 group 存在於目前 nodes;不存在則清為頂層,
    // 避免 React Flow 因 parentId 指向不存在節點而出錯。
    const groupExists = nodes.some(
      (n) => n.id === editNode.group && n.type === 'archGroup',
    );
    const groupSel = editNode.group && groupExists ? editNode.group : undefined;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== oldId) {
          // 若有節點 parentId 指向被改名的 node → 一併更新。
          if (n.parentId === oldId) return { ...n, parentId: newId };
          return n;
        }
        const data = { ...n.data, nid: newId, title: editNode.title, icon: editNode.icon };
        const next: Node = { ...n, id: newId, data };
        // service/junction → 所屬 group;group → parent。設定 parentId + extent。
        if (groupSel) {
          next.parentId = groupSel;
          next.extent = 'parent';
        } else {
          delete next.parentId;
          delete next.extent;
        }
        return next;
      }),
    );
    // 改 id 後同步更新邊端點。
    if (newId !== oldId) {
      setEdges((es) =>
        es.map((e) => ({
          ...e,
          source: e.source === oldId ? newId : e.source,
          target: e.target === oldId ? newId : e.target,
        })),
      );
    }
    setEditNode(null);
  };

  const applyEdge = () => {
    if (!editEdge) return;
    takeSnapshot();
    const { arrowFrom, arrowTo } = fromArrowKind(editEdge.arrow);
    setEdges((es) =>
      es.map((e) => {
        if (e.id !== editEdge.id) return e;
        const data: EdgeData = {
          fromSide: editEdge.fromSide,
          toSide: editEdge.toSide,
          arrowFrom,
          arrowTo,
        };
        return {
          ...e,
          data,
          sourceHandle: `s-${editEdge.fromSide}`,
          targetHandle: `t-${editEdge.toSide}`,
          markerStart: arrowFrom ? { type: MarkerType.ArrowClosed } : undefined,
          markerEnd: arrowTo ? { type: MarkerType.ArrowClosed } : undefined,
        };
      }),
    );
    setEditEdge(null);
  };

  const deleteEdge = () => {
    if (!editEdge) return;
    takeSnapshot();
    setEdges((es) => es.filter((e) => e.id !== editEdge.id));
    setEditEdge(null);
  };

  const save = () => {
    const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
    const groups: ArchGroup[] = [];
    const services: ArchService[] = [];
    const junctions: ArchJunction[] = [];

    for (const n of nodes) {
      const d = n.data as { nid?: string; title?: string; icon?: string };
      const id = String(d.nid ?? n.id);
      const parent = n.parentId ? String(n.parentId) : undefined;
      if (n.type === 'archGroup') {
        groups.push({ id, title: d.title?.trim() || undefined, icon: d.icon?.trim() || undefined, parent });
      } else if (n.type === 'junction') {
        junctions.push({ id, group: parent });
      } else {
        services.push({ id, title: d.title?.trim() || undefined, icon: d.icon?.trim() || undefined, group: parent });
      }
    }

    // 過濾掉端點已不存在的邊。
    const edgeList: ArchEdge[] = edges.flatMap((e) => {
      const src = nodes.find((n) => n.id === e.source);
      const tgt = nodes.find((n) => n.id === e.target);
      if (!src || !tgt) return [];
      const d = (e.data ?? {}) as Partial<EdgeData>;
      const srcId = String((src.data as { nid?: string }).nid ?? e.source);
      const tgtId = String((tgt.data as { nid?: string }).nid ?? e.target);
      return [
        {
          from: srcId,
          fromSide: d.fromSide ?? handleSide(e.sourceHandle, 'R'),
          to: tgtId,
          toSide: d.toSide ?? handleSide(e.targetHandle, 'L'),
          arrowFrom: d.arrowFrom ?? false,
          arrowTo: d.arrowTo ?? false,
          fromGroup: typeOf.get(e.source) === 'archGroup' || undefined,
          toGroup: typeOf.get(e.target) === 'archGroup' || undefined,
        },
      ];
    });

    const model: ArchModel = { groups, services, junctions, edges: edgeList };
    onSave(serializeArchitecture(model));
  };

  // group Select 選項(自身不可當自己的 parent)。
  const groupOptions = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'archGroup' && (!editNode || n.id !== editNode.id))
        .map((n) => {
          const d = n.data as { nid?: string; title?: string };
          return { value: n.id, label: d.title ? `${d.nid} (${d.title})` : String(d.nid ?? n.id) };
        }),
    [nodes, editNode],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: fill ? '100%' : '70vh' }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Button
          icon={<PlusOutlined />}
          onClick={() => setAdding({ kind: 'service', id: '' })}
          data-loc="arch:add-service"
        >
          新增 service
        </Button>
        <Button
          icon={<ApartmentOutlined />}
          onClick={() => setAdding({ kind: 'archGroup', id: '' })}
          data-loc="arch:add-group"
        >
          新增 group
        </Button>
        <Space.Compact>
          <Button
            size="small"
            icon={<UndoOutlined />}
            disabled={!past.length}
            onClick={undo}
            title="復原(Ctrl+Z)"
            data-loc="arch:undo"
          />
          <Button
            size="small"
            icon={<RedoOutlined />}
            disabled={!future.length}
            onClick={redo}
            title="重做(Ctrl+Y)"
            data-loc="arch:redo"
          />
        </Space.Compact>
        <Button
          size="small"
          onClick={() => {
            takeSnapshot();
            reLayout();
          }}
          data-loc="arch:layout"
        >
          自動排版
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          雙擊 service/group 改設定 · 雙擊邊改側邊/箭頭 · 拖把手連線 · Delete 刪 · Ctrl+C/V · Ctrl+Z/Y
        </Typography.Text>
      </Space>

      <div
        style={{
          flex: 1,
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          minHeight: 0,
          outline: 'none',
        }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-loc="arch:canvas"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={() => takeSnapshot()}
          onNodeDoubleClick={(_e, n) => {
            // junction 也能開編輯 Modal,但只給 id 與「所屬 group」可編(無 title/icon)。
            const d = n.data as { nid?: string; title?: string; icon?: string };
            setEditNode({
              id: n.id,
              kind:
                n.type === 'archGroup' || n.type === 'junction'
                  ? n.type
                  : 'service',
              nid: String(d.nid ?? n.id),
              title: d.title ?? '',
              icon: d.icon ?? '',
              group: n.parentId ? String(n.parentId) : '',
            });
          }}
          nodeTypes={nodeTypes}
          onEdgeDoubleClick={(_e, ed) => {
            const d = (ed.data ?? {}) as Partial<EdgeData>;
            setEditEdge({
              id: ed.id,
              fromSide: d.fromSide ?? 'R',
              toSide: d.toSide ?? 'L',
              arrow: toArrowKind(d.arrowFrom ?? false, d.arrowTo ?? false),
            });
          }}
          deleteKeyCode={['Delete', 'Backspace']}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <Space style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onClose} data-loc="arch:cancel">
          取消
        </Button>
        <Button type="primary" onClick={save} data-loc="arch:apply">
          套用
        </Button>
      </Space>

      {/* node 編輯:id / title / icon / 所屬 group(group 則為 parent) */}
      <Modal
        title={
          editNode?.kind === 'archGroup'
            ? '編輯 group'
            : editNode?.kind === 'junction'
              ? '編輯 junction'
              : '編輯 service'
        }
        open={!!editNode}
        onOk={applyNode}
        onCancel={() => setEditNode(null)}
        okText="確定"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <span>
            id{' '}
            <Input
              style={{ width: 240 }}
              value={editNode?.nid ?? ''}
              onChange={(e) => setEditNode((s) => (s ? { ...s, nid: e.target.value } : s))}
              data-loc="arch:node-id"
            />
          </span>
          {/* junction 僅可編 id 與所屬 group(無 title / icon)。 */}
          {editNode?.kind !== 'junction' && (
            <>
              <span>
                title{' '}
                <Input
                  style={{ width: 240 }}
                  value={editNode?.title ?? ''}
                  onChange={(e) => setEditNode((s) => (s ? { ...s, title: e.target.value } : s))}
                  placeholder="(可空白)"
                  data-loc="arch:node-title"
                />
              </span>
              <span>
                icon{' '}
                <Select
                  style={{ width: 240 }}
                  allowClear
                  showSearch
                  value={editNode?.icon || undefined}
                  onChange={(v?: string) => setEditNode((s) => (s ? { ...s, icon: v ?? '' } : s))}
                  placeholder="內建或 iconify 名稱(如 logos:aws)"
                  options={BUILTIN_ICONS.map((i) => ({ value: i, label: i }))}
                  // 允許自填非內建 icon 名稱。
                  onSearch={() => undefined}
                  filterOption={(input, opt) =>
                    String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  data-loc="arch:node-icon"
                />
              </span>
              {/* 自填 icon(iconify)輸入 */}
              <span>
                自填 icon{' '}
                <Input
                  style={{ width: 240 }}
                  value={editNode?.icon ?? ''}
                  onChange={(e) => setEditNode((s) => (s ? { ...s, icon: e.target.value } : s))}
                  placeholder="如 logos:aws"
                  data-loc="arch:node-icon-text"
                />
              </span>
            </>
          )}
          <span>
            {editNode?.kind === 'archGroup' ? '父 group' : '所屬 group'}{' '}
            <Select
              style={{ width: 240 }}
              allowClear
              value={editNode?.group || undefined}
              onChange={(v?: string) => setEditNode((s) => (s ? { ...s, group: v ?? '' } : s))}
              placeholder="(無)"
              options={groupOptions}
              data-loc="arch:node-group"
            />
          </span>
        </Space>
      </Modal>

      {/* 邊編輯:fromSide / toSide / 箭頭 / 刪 */}
      <Modal
        title="編輯連線"
        open={!!editEdge}
        onOk={applyEdge}
        onCancel={() => setEditEdge(null)}
        okText="確定"
        cancelText="取消"
        footer={[
          <Button key="del" danger onClick={deleteEdge} data-loc="arch:edge-del">
            刪除此連線
          </Button>,
          <Button key="cancel" onClick={() => setEditEdge(null)}>
            取消
          </Button>,
          <Button key="ok" type="primary" onClick={applyEdge}>
            確定
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <span>
            起點側邊{' '}
            <Select
              style={{ width: 160 }}
              value={editEdge?.fromSide ?? 'R'}
              onChange={(v: Side) => setEditEdge((s) => (s ? { ...s, fromSide: v } : s))}
              options={SIDE_OPTS}
              data-loc="arch:edge-from-side"
            />
          </span>
          <span>
            終點側邊{' '}
            <Select
              style={{ width: 160 }}
              value={editEdge?.toSide ?? 'L'}
              onChange={(v: Side) => setEditEdge((s) => (s ? { ...s, toSide: v } : s))}
              options={SIDE_OPTS}
              data-loc="arch:edge-to-side"
            />
          </span>
          <span>
            箭頭{' '}
            <Select
              style={{ width: 200 }}
              value={editEdge?.arrow ?? 'none'}
              onChange={(v: ArrowKind) => setEditEdge((s) => (s ? { ...s, arrow: v } : s))}
              options={ARROW_OPTS}
              data-loc="arch:edge-arrow"
            />
          </span>
        </Space>
      </Modal>

      {/* 新增 service / group */}
      <Modal
        title={adding?.kind === 'archGroup' ? '新增 group' : '新增 service'}
        open={adding !== null}
        onOk={doAdd}
        onCancel={() => setAdding(null)}
        okText="新增"
        cancelText="取消"
        okButtonProps={{ disabled: !adding?.id.trim() }}
      >
        <Input
          autoFocus
          value={adding?.id ?? ''}
          onChange={(e) => setAdding((s) => (s ? { ...s, id: e.target.value } : s))}
          onPressEnter={doAdd}
          placeholder="id(如 db、api)"
          data-loc="arch:add-id"
        />
      </Modal>
    </div>
  );
}
