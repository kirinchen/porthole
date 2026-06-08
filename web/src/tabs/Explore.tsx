/**
 * Explore tab — files tree(lazy)+ 點檔預覽 / 編輯。
 *  - 預覽:markdown 走 react-markdown,其餘純文字。
 *  - 編輯:可改既存檔、可新增檔(PUT /api/:repo/file);寫入面受 path-guard 鎖在 repo root 內。
 */
import { useEffect, useState, lazy, Suspense } from 'react';
import { Tree, Empty, Spin, Alert, Grid, Drawer, Button, Typography, Input, Modal, Space } from 'antd';
import type { TreeDataNode } from 'antd';
import {
  MenuOutlined,
  EditOutlined,
  SaveOutlined,
  CloseOutlined,
  FileAddOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';

// CM6 編輯器較重 → lazy load,只有編輯 md 時才拉這個 chunk(守「薄」)。
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor'));

interface Props {
  repo: string;
}

type Node = TreeDataNode & { path: string; isLeaf: boolean };

interface Selected {
  path: string;
  content: string;
  markdown: boolean;
  isNew?: boolean; // 新檔尚未存到磁碟
}

function toNode(item: { name: string; path: string; type: 'dir' | 'file' }): Node {
  return {
    title: item.name,
    key: item.path,
    path: item.path,
    isLeaf: item.type === 'file',
  };
}

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

export default function Explore({ repo }: Props) {
  const [tree, setTree] = useState<Node[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Selected | null>(null);
  const [selPath, setSelPath] = useState<string | null>(null); // 最後選取的節點(檔或資料夾)→ 標題
  const [loadingFile, setLoadingFile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md; // <768px:檔案樹收進抽屜,預覽吃滿寬

  const reloadTree = () => {
    api
      .tree(repo, '.')
      .then((r) => setTree(r.items.map(toNode)))
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    setTree([]);
    setSel(null);
    setSelPath(null);
    setEditing(false);
    setErr(null);
    reloadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setSelPath(n.path); // 標題同步選取的節點(檔或資料夾)
    if (!n.isLeaf) return; // 資料夾:只更新標題,不載預覽
    setLoadingFile(true);
    setErr(null);
    setEditing(false);
    setSaveErr(null);
    setNote(null);
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

  const startEdit = () => {
    if (!sel) return;
    setDraft(sel.content);
    setSaveErr(null);
    setNote(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveErr(null);
    if (sel?.isNew) setSel(null); // 取消新檔 → 清掉
  };

  const save = async () => {
    if (!sel) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await api.writeFile(repo, sel.path, draft);
      const wasNew = sel.isNew;
      setSel({ path: sel.path, content: draft, markdown: sel.markdown, isNew: false });
      setEditing(false);
      setNote(`已儲存 ${sel.path}`);
      if (wasNew) reloadTree(); // 新檔 → 重載樹讓它出現
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createNew = () => {
    const p = newPath.trim().replace(/^[/\\]+/, '');
    if (!p) return;
    setNewOpen(false);
    setNewPath('');
    setDrawerOpen(false);
    setErr(null);
    setNote(null);
    setSaveErr(null);
    setSel({ path: p, content: '', markdown: isMd(p), isNew: true });
    setSelPath(p);
    setDraft('');
    setEditing(true);
  };

  const treePanel = (
    <>
      <Button
        block
        icon={<FileAddOutlined />}
        onClick={() => setNewOpen(true)}
        style={{ marginBottom: 8 }}
        data-loc="explore:file:new"
      >
        新檔
      </Button>
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
        {(isMobile || sel || selPath) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: '1px solid #f0f0f0',
            }}
            data-loc="explore:toolbar"
          >
            {isMobile && (
              <Button
                icon={<MenuOutlined />}
                onClick={() => setDrawerOpen(true)}
                data-loc="explore:tree:toggle"
              />
            )}
            <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
              {selPath ?? '選一個項目'}
              {sel?.isNew && selPath === sel.path ? ' (新檔)' : ''}
            </Typography.Text>
            {sel &&
              (editing ? (
                <Space.Compact>
                  <Button
                    type="primary"
                    icon={<SaveOutlined />}
                    loading={saving}
                    onClick={() => void save()}
                    data-loc="explore:edit:save"
                  >
                    儲存
                  </Button>
                  <Button icon={<CloseOutlined />} onClick={cancelEdit} data-loc="explore:edit:cancel">
                    取消
                  </Button>
                </Space.Compact>
              ) : (
                <Button icon={<EditOutlined />} onClick={startEdit} data-loc="explore:edit:start">
                  編輯
                </Button>
              ))}
          </div>
        )}

        {(note || saveErr) && (
          <div style={{ padding: '8px 12px 0' }}>
            {note && <Alert type="success" message={note} closable onClose={() => setNote(null)} />}
            {saveErr && <Alert type="error" message={saveErr} style={{ marginTop: note ? 8 : 0 }} />}
          </div>
        )}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: editing && sel?.markdown ? 'hidden' : 'auto',
            padding: editing && sel?.markdown ? 0 : 16,
          }}
        >
          {editing && sel ? (
            sel.markdown ? (
              <Suspense fallback={<Spin />}>
                <MarkdownEditor key={sel.path} value={draft} onChange={setDraft} />
              </Suspense>
            ) : (
              <Input.TextArea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{
                  height: '100%',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 13,
                  resize: 'none',
                }}
                data-loc="explore:edit:textarea"
              />
            )
          ) : loadingFile ? (
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

      <Modal
        title="新增檔案"
        open={newOpen}
        onOk={createNew}
        onCancel={() => {
          setNewOpen(false);
          setNewPath('');
        }}
        okText="建立"
        cancelText="取消"
        okButtonProps={{ disabled: !newPath.trim() }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          相對 {repo} root 的路徑(中間目錄會自動建立)。
        </Typography.Paragraph>
        <Input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onPressEnter={createNew}
          placeholder="例如 doc/note/idea.md"
          data-loc="explore:file:new:path"
        />
      </Modal>
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
