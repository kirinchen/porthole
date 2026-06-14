/**
 * FlowEditor — flowchart 子集 的 GUI 編輯器(React Flow + dagre 自動排版)。
 *  - 解析 mermaid → 節點 / 邊 → dagre 排版 → React Flow 畫布。
 *  - double-click 節點 / 邊 → 改標籤;拖把手連線 → 新增邊;Delete 鍵刪選取;按鈕新增節點。
 *  - 「套用」→ serializeFlow → onSave(正規化 mermaid 文字)。
 *  本元件較重(React Flow + dagre)→ 由 Explore 以 lazy + Suspense 載入。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
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
import { Button, Modal, Input, Select, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { parseFlow, serializeFlow, type FlowGraph, type FlowShape } from '../lib/mermaidFlow';

const SHAPE_OPTS: { value: FlowShape; label: string }[] = [
  { value: 'rect', label: '矩形' },
  { value: 'round', label: '圓角' },
  { value: 'diamond', label: '菱形(判斷)' },
];

/** 自訂節點:依 data.shape 用 SVG 畫矩形 / 圓角 / 菱形,標籤置中,上下接點。 */
function ShapedNode({ data }: NodeProps) {
  const d = data as { label?: string; shape?: FlowShape };
  const shape = d.shape ?? 'rect';
  const w = NODE_W;
  const h = NODE_H;
  const shapeEl =
    shape === 'diamond' ? (
      <polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} fill="#fff" stroke="#555" />
    ) : shape === 'round' ? (
      <rect x="1" y="1" width={w - 2} height={h - 2} rx={h / 2} ry={h / 2} fill="#fff" stroke="#555" />
    ) : (
      <rect x="1" y="1" width={w - 2} height={h - 2} rx="4" fill="#fff" stroke="#555" />
    );
  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0, display: 'block' }}>
        {shapeEl}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          textAlign: 'center',
          padding: shape === 'diamond' ? '0 22px' : '0 8px',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {d.label}
      </div>
      <Handle type="target" position={Position.Top} style={{ background: '#555' }} />
      <Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />
    </div>
  );
}

interface Props {
  code: string;
  onSave: (code: string) => void;
  onClose: () => void;
  /** 滿版模式:撐滿父容器高度(由 MermaidBlock 的全螢幕切換帶入)。 */
  fill?: boolean;
}

const NODE_W = 150;
const NODE_H = 44;

function layout(nodes: Node[], edges: Edge[], dir: string): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir === 'TD' ? 'TB' : dir, nodesep: 40, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

export default function FlowEditor({ code, onSave, onClose, fill }: Props) {
  const nodeTypes = useMemo(() => ({ shaped: ShapedNode }), []);

  const init = useMemo(() => {
    const gph = parseFlow(code);
    const ns: Node[] = gph.nodes.map((n) => ({
      id: n.id,
      type: 'shaped',
      data: { label: n.label, shape: n.shape },
      position: { x: 0, y: 0 },
    }));
    const es: Edge[] = gph.edges.map((e, i) => ({
      id: `e${i}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      label: e.label,
    }));
    return { dir: gph.dir, nodes: layout(ns, es, gph.dir), edges: es };
  }, [code]);

  const [nodes, setNodes] = useState<Node[]>(init.nodes);
  const [edges, setEdges] = useState<Edge[]>(init.edges);
  const [dir, setDir] = useState(init.dir);
  const [seq, setSeq] = useState(1);
  const [editNode, setEditNode] = useState<{ id: string; label: string; shape: FlowShape } | null>(
    null,
  );
  const [editEdge, setEditEdge] = useState<{ id: string; label: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addShape, setAddShape] = useState<FlowShape>('rect');

  const onNodesChange = useCallback(
    (c: NodeChange[]) => setNodes((n) => applyNodeChanges(c, n)),
    [],
  );
  const onEdgesChange = useCallback(
    (c: EdgeChange[]) => setEdges((e) => applyEdgeChanges(c, e)),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((e) =>
        addEdge({ ...c, id: `e-${c.source}-${c.target}-${e.length}` }, e),
      ),
    [],
  );

  const reLayout = (d = dir) => setNodes((n) => layout(n, edges, d));

  const addNode = () => {
    const label = (adding ?? '').trim();
    if (!label) return;
    let id = `n${seq}`;
    let s = seq;
    while (nodes.some((n) => n.id === id)) id = `n${++s}`;
    setSeq(s + 1);
    setNodes((n) => [
      ...n,
      { id, type: 'shaped', data: { label, shape: addShape }, position: { x: 40, y: 40 } },
    ]);
    setAdding(null);
    setAddShape('rect');
  };

  const applyNodeLabel = () => {
    if (!editNode) return;
    setNodes((ns) =>
      ns.map((n) =>
        n.id === editNode.id
          ? { ...n, data: { ...n.data, label: editNode.label, shape: editNode.shape } }
          : n,
      ),
    );
    setEditNode(null);
  };

  const applyEdgeLabel = () => {
    if (!editEdge) return;
    setEdges((es) =>
      es.map((e) => (e.id === editEdge.id ? { ...e, label: editEdge.label } : e)),
    );
    setEditEdge(null);
  };

  const deleteEdge = () => {
    if (!editEdge) return;
    setEdges((es) => es.filter((e) => e.id !== editEdge.id));
    setEditEdge(null);
  };

  const save = () => {
    const g: FlowGraph = {
      dir,
      nodes: nodes.map((n) => ({
        id: n.id,
        label: String(n.data.label ?? n.id),
        shape: (n.data.shape as FlowShape) ?? 'rect',
      })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label ? String(e.label) : undefined,
      })),
    };
    onSave(serializeFlow(g));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: fill ? '100%' : '70vh' }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Button icon={<PlusOutlined />} onClick={() => setAdding('')} data-loc="flow:add-node">
          新增節點
        </Button>
        <span>
          方向{' '}
          <Select
            size="small"
            value={dir}
            onChange={(d) => {
              setDir(d);
              reLayout(d);
            }}
            style={{ width: 88 }}
            options={['TD', 'LR', 'BT', 'RL'].map((d) => ({ value: d, label: d }))}
          />
        </span>
        <Button size="small" onClick={() => reLayout()}>
          自動排版
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          雙擊節點/邊改字 · 拖把手連線 · Delete 刪選取
        </Typography.Text>
      </Space>

      <div style={{ flex: 1, border: '1px solid #f0f0f0', borderRadius: 8, minHeight: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={(_e, n) =>
            setEditNode({
              id: n.id,
              label: String(n.data.label ?? ''),
              shape: (n.data.shape as FlowShape) ?? 'rect',
            })
          }
          nodeTypes={nodeTypes}
          onEdgeDoubleClick={(_e, ed) => setEditEdge({ id: ed.id, label: String(ed.label ?? '') })}
          deleteKeyCode={['Delete', 'Backspace']}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <Space style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" onClick={save} data-loc="flow:apply">
          套用
        </Button>
      </Space>

      <Modal
        title="節點標籤"
        open={!!editNode}
        onOk={applyNodeLabel}
        onCancel={() => setEditNode(null)}
        okText="確定"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            autoFocus
            value={editNode?.label ?? ''}
            onChange={(e) => setEditNode((s) => (s ? { ...s, label: e.target.value } : s))}
            onPressEnter={applyNodeLabel}
          />
          <span>
            形狀{' '}
            <Select
              size="small"
              value={editNode?.shape ?? 'rect'}
              onChange={(v) => setEditNode((s) => (s ? { ...s, shape: v } : s))}
              style={{ width: 140 }}
              options={SHAPE_OPTS}
            />
          </span>
        </Space>
      </Modal>

      <Modal
        title="邊標籤"
        open={!!editEdge}
        onOk={applyEdgeLabel}
        onCancel={() => setEditEdge(null)}
        okText="確定"
        cancelText="取消"
        footer={[
          <Button key="del" danger onClick={deleteEdge}>
            刪除此邊
          </Button>,
          <Button key="cancel" onClick={() => setEditEdge(null)}>
            取消
          </Button>,
          <Button key="ok" type="primary" onClick={applyEdgeLabel}>
            確定
          </Button>,
        ]}
      >
        <Input
          autoFocus
          value={editEdge?.label ?? ''}
          onChange={(e) => setEditEdge((s) => (s ? { ...s, label: e.target.value } : s))}
          onPressEnter={applyEdgeLabel}
          placeholder="(可空白)"
        />
      </Modal>

      <Modal
        title="新增節點"
        open={adding !== null}
        onOk={addNode}
        onCancel={() => setAdding(null)}
        okText="新增"
        cancelText="取消"
        okButtonProps={{ disabled: !adding?.trim() }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            autoFocus
            value={adding ?? ''}
            onChange={(e) => setAdding(e.target.value)}
            onPressEnter={addNode}
            placeholder="節點文字"
          />
          <span>
            形狀{' '}
            <Select
              size="small"
              value={addShape}
              onChange={setAddShape}
              style={{ width: 140 }}
              options={SHAPE_OPTS}
            />
          </span>
        </Space>
      </Modal>
    </div>
  );
}
