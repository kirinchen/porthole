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
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { Button, Modal, Input, Select, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { parseFlow, serializeFlow, type FlowGraph } from '../lib/mermaidFlow';

interface Props {
  code: string;
  onSave: (code: string) => void;
  onClose: () => void;
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

export default function FlowEditor({ code, onSave, onClose }: Props) {
  const init = useMemo(() => {
    const gph = parseFlow(code);
    const ns: Node[] = gph.nodes.map((n) => ({
      id: n.id,
      data: { label: n.label },
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
  const [editNode, setEditNode] = useState<{ id: string; label: string } | null>(null);
  const [editEdge, setEditEdge] = useState<{ id: string; label: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

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
    setNodes((n) => [...n, { id, data: { label }, position: { x: 40, y: 40 } }]);
    setAdding(null);
  };

  const applyNodeLabel = () => {
    if (!editNode) return;
    setNodes((ns) =>
      ns.map((n) => (n.id === editNode.id ? { ...n, data: { ...n.data, label: editNode.label } } : n)),
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
      nodes: nodes.map((n) => ({ id: n.id, label: String(n.data.label ?? n.id) })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label ? String(e.label) : undefined,
      })),
    };
    onSave(serializeFlow(g));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '70vh' }}>
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
          onNodeDoubleClick={(_e, n) => setEditNode({ id: n.id, label: String(n.data.label ?? '') })}
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
        <Input
          autoFocus
          value={editNode?.label ?? ''}
          onChange={(e) => setEditNode((s) => (s ? { ...s, label: e.target.value } : s))}
          onPressEnter={applyNodeLabel}
        />
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
        <Input
          autoFocus
          value={adding ?? ''}
          onChange={(e) => setAdding(e.target.value)}
          onPressEnter={addNode}
          placeholder="節點文字"
        />
      </Modal>
    </div>
  );
}
