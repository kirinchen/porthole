/**
 * Explore tab — files tree(lazy)+ 點檔預覽(markdown 走 react-markdown,其餘純文字)。唯讀。
 */
import { useEffect, useState } from 'react';
import { Tree, Empty, Spin, Alert, Grid, Drawer, Button, Typography } from 'antd';
import type { TreeDataNode } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';

interface Props {
  repo: string;
}

type Node = TreeDataNode & { path: string; isLeaf: boolean };

function toNode(item: { name: string; path: string; type: 'dir' | 'file' }): Node {
  return {
    title: item.name,
    key: item.path,
    path: item.path,
    isLeaf: item.type === 'file',
  };
}

export default function Explore({ repo }: Props) {
  const [tree, setTree] = useState<Node[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ path: string; content: string; markdown: boolean } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md; // <768px:檔案樹收進抽屜,預覽吃滿寬

  useEffect(() => {
    setTree([]);
    setSel(null);
    setErr(null);
    api
      .tree(repo, '.')
      .then((r) => setTree(r.items.map(toNode)))
      .catch((e: Error) => setErr(e.message));
  }, [repo]);

  const onLoadData = async (node: TreeDataNode): Promise<void> => {
    const n = node as Node;
    if (n.children || n.isLeaf) return;
    const r = await api.tree(repo, n.path);
    const children = r.items.map(toNode);
    setTree((prev) => updateChildren(prev, n.key as string, children));
  };

  const onSelect = async (_keys: React.Key[], info: { node: TreeDataNode }) => {
    const n = info.node as Node;
    if (!n.isLeaf) return;
    setLoadingFile(true);
    setErr(null);
    try {
      const f = await api.file(repo, n.path);
      setSel({ path: n.path, content: f.content, markdown: f.markdown });
      setDrawerOpen(false); // 手機:選檔後關抽屜露出預覽
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingFile(false);
    }
  };

  const treePanel = (
    <>
      {err && <Alert type="error" message={err} style={{ marginBottom: 8 }} />}
      {tree.length === 0 && !err ? (
        <Spin />
      ) : (
        <Tree.DirectoryTree treeData={tree} loadData={onLoadData} onSelect={onSelect} blockNode />
      )}
    </>
  );

  return (
    <div style={{ display: 'flex', height: '100%' }} data-loc="explore:root">
      {!isMobile && (
        <div
          style={{ width: 300, overflow: 'auto', borderRight: '1px solid #f0f0f0', padding: 8 }}
          data-loc="explore:tree"
        >
          {treePanel}
        </div>
      )}

      {isMobile && (
        <Drawer
          title="檔案"
          placement="left"
          width={300}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          styles={{ body: { padding: 8 } }}
          data-loc="explore:tree:drawer"
        >
          {treePanel}
        </Drawer>
      )}

      <div
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        data-loc="explore:preview"
      >
        {isMobile && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Button
              icon={<MenuOutlined />}
              onClick={() => setDrawerOpen(true)}
              data-loc="explore:tree:toggle"
            />
            <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
              {sel?.path ?? '選一個檔案'}
            </Typography.Text>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 16 }}>
        {loadingFile ? (
          <Spin />
        ) : !sel ? (
          <Empty description="選一個檔案預覽" />
        ) : sel.markdown ? (
          <div className="md-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{sel.content}</ReactMarkdown>
          </div>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
            {sel.content}
          </pre>
        )}
        </div>
      </div>
    </div>
  );
}

/** 不可變更新某 key 的 children。 */
function updateChildren(nodes: Node[], key: string, children: Node[]): Node[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: updateChildren(n.children as Node[], key, children) };
    return n;
  });
}
