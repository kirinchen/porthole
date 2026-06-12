/**
 * Explore — 檔案樹 + 預覽/編輯,拆成可獨立擺位的兩塊:
 *   - <ExploreProvider repo>  共用狀態(樹、選取、編輯草稿…)
 *   - <ExploreTree/>          檔案樹(桌面:左欄,可最小化;手機:Drawer)
 *   - <ExplorePreview/>       預覽/編輯(中央主區)
 * 拆開是為了讓 App 把樹固定在左欄、預覽放中央,右側面板「撐滿」時只蓋中央
 * preview、樹仍在(三區佈局)。「樹/預覽要不要縮」由 Explore 自己控制。
 *
 * 預覽:markdown 走 react-markdown,其餘純文字。編輯:可改既存檔、可新增檔
 * (PUT /api/:repo/file),寫入面受 path-guard 鎖在 repo root 內。
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import { Tree, Empty, Spin, Alert, Grid, Drawer, Button, Typography, Input, Modal, Space } from 'antd';
import type { TreeDataNode } from 'antd';
import {
  MenuOutlined,
  EditOutlined,
  SaveOutlined,
  CloseOutlined,
  FileAddOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { api } from '../lib/api';
import Markdown from '../components/Markdown';

// CM6 編輯器較重 → lazy load(守「薄」)。mermaid/FlowEditor 在 MermaidBlock 內按需載入。
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor'));

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

/** 不可變更新某 key 的 children。 */
function updateChildren(nodes: Node[], key: string, children: Node[]): Node[] {
  return nodes.map((n) => {
    if (n.key === key) return { ...n, children };
    if (n.children) return { ...n, children: updateChildren(n.children as Node[], key, children) };
    return n;
  });
}

interface ExploreCtx {
  repo: string;
  isMobile: boolean;
  tree: Node[];
  err: string | null;
  sel: Selected | null;
  selPath: string | null;
  loadingFile: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (b: boolean) => void;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  saving: boolean;
  saveErr: string | null;
  note: string | null;
  setNote: (s: string | null) => void;
  newOpen: boolean;
  setNewOpen: (b: boolean) => void;
  newPath: string;
  setNewPath: (s: string) => void;
  treeMin: boolean;
  setTreeMin: (b: boolean) => void;
  onLoadData: (node: TreeDataNode) => Promise<void>;
  onSelect: (keys: React.Key[], info: { node: TreeDataNode }) => void;
  startEdit: () => void;
  cancelEdit: () => void;
  save: () => void;
  createNew: () => void;
}

const Ctx = createContext<ExploreCtx | null>(null);

function useExplore(): ExploreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useExplore 必須在 <ExploreProvider> 內使用');
  return c;
}

export function ExploreProvider({ repo, children }: { repo: string; children: ReactNode }) {
  const [tree, setTree] = useState<Node[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Selected | null>(null);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [treeMin, setTreeMin] = useState(false);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

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
    setSelPath(n.path);
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

  const value: ExploreCtx = {
    repo,
    isMobile,
    tree,
    err,
    sel,
    selPath,
    loadingFile,
    drawerOpen,
    setDrawerOpen,
    editing,
    draft,
    setDraft,
    saving,
    saveErr,
    note,
    setNote,
    newOpen,
    setNewOpen,
    newPath,
    setNewPath,
    treeMin,
    setTreeMin,
    onLoadData,
    onSelect,
    startEdit,
    cancelEdit,
    save: () => void save(),
    createNew,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 檔案樹面板(新檔 / 最小化鈕 + Tree)。 */
function TreePanel() {
  const c = useExplore();
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <Button
          icon={<FileAddOutlined />}
          onClick={() => c.setNewOpen(true)}
          title="新檔"
          data-loc="explore:file:new"
        />
        {!c.isMobile && (
          <Button
            icon={<LeftOutlined />}
            onClick={() => c.setTreeMin(true)}
            title="最小化檔案樹"
            data-loc="explore:tree:minimize"
          />
        )}
      </div>
      {c.err && <Alert type="error" message={c.err} style={{ marginBottom: 8 }} />}
      {c.tree.length === 0 && !c.err ? (
        <Spin />
      ) : (
        <Tree.DirectoryTree
          treeData={c.tree}
          loadData={c.onLoadData}
          onSelect={c.onSelect}
          blockNode
        />
      )}
    </>
  );
}

/** 檔案樹:桌面 = 左欄(可最小化成細條);手機 = Drawer。 */
export function ExploreTree() {
  const c = useExplore();

  if (c.isMobile) {
    return (
      <Drawer
        title="檔案"
        placement="left"
        width={300}
        open={c.drawerOpen}
        onClose={() => c.setDrawerOpen(false)}
        styles={{ body: { padding: 8 } }}
        data-loc="explore:tree:drawer"
      >
        <TreePanel />
      </Drawer>
    );
  }

  return c.treeMin ? (
    <div
      style={{
        width: 40,
        borderRight: '1px solid #f0f0f0',
        padding: 4,
        display: 'flex',
        justifyContent: 'center',
      }}
      data-loc="explore:tree:min"
    >
      <Button
        icon={<RightOutlined />}
        onClick={() => c.setTreeMin(false)}
        title="原本(展開檔案樹)"
        data-loc="explore:tree:restore"
      />
    </div>
  ) : (
    <div
      style={{ width: 300, overflow: 'auto', borderRight: '1px solid #f0f0f0', padding: 8 }}
      data-loc="explore:tree"
    >
      <TreePanel />
    </div>
  );
}

/** 預覽 / 編輯(中央主區)。 */
export function ExplorePreview() {
  const c = useExplore();
  return (
    <div
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      data-loc="explore:preview"
    >
      {(c.isMobile || c.sel || c.selPath) && (
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
          {c.isMobile && (
            <Button
              icon={<MenuOutlined />}
              onClick={() => c.setDrawerOpen(true)}
              data-loc="explore:tree:toggle"
            />
          )}
          <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
            {c.selPath ?? '選一個項目'}
            {c.sel?.isNew && c.selPath === c.sel.path ? ' (新檔)' : ''}
          </Typography.Text>
          {c.sel &&
            (c.editing ? (
              <Space.Compact>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={c.saving}
                  onClick={c.save}
                  data-loc="explore:edit:save"
                >
                  儲存
                </Button>
                <Button icon={<CloseOutlined />} onClick={c.cancelEdit} data-loc="explore:edit:cancel">
                  取消
                </Button>
              </Space.Compact>
            ) : (
              <Button icon={<EditOutlined />} onClick={c.startEdit} data-loc="explore:edit:start">
                編輯
              </Button>
            ))}
        </div>
      )}

      {(c.note || c.saveErr) && (
        <div style={{ padding: '8px 12px 0' }}>
          {c.note && (
            <Alert type="success" message={c.note} closable onClose={() => c.setNote(null)} />
          )}
          {c.saveErr && (
            <Alert type="error" message={c.saveErr} style={{ marginTop: c.note ? 8 : 0 }} />
          )}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: c.editing && c.sel?.markdown ? 'hidden' : 'auto',
          padding: c.editing && c.sel?.markdown ? 0 : 16,
        }}
      >
        {c.editing && c.sel ? (
          c.sel.markdown ? (
            <Suspense fallback={<Spin />}>
              <MarkdownEditor key={c.sel.path} value={c.draft} onChange={c.setDraft} />
            </Suspense>
          ) : (
            <Input.TextArea
              value={c.draft}
              onChange={(e) => c.setDraft(e.target.value)}
              style={{
                height: '100%',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                resize: 'none',
              }}
              data-loc="explore:edit:textarea"
            />
          )
        ) : c.loadingFile ? (
          <Spin />
        ) : !c.sel ? (
          <Empty description="選一個檔案預覽" />
        ) : c.sel.markdown ? (
          <div className="md-preview">
            <Markdown>{c.sel.content}</Markdown>
          </div>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
            {c.sel.content}
          </pre>
        )}
      </div>

      <Modal
        title="新增檔案"
        open={c.newOpen}
        onOk={c.createNew}
        onCancel={() => {
          c.setNewOpen(false);
          c.setNewPath('');
        }}
        okText="建立"
        cancelText="取消"
        okButtonProps={{ disabled: !c.newPath.trim() }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          相對 {c.repo} root 的路徑(中間目錄會自動建立)。
        </Typography.Paragraph>
        <Input
          value={c.newPath}
          onChange={(e) => c.setNewPath(e.target.value)}
          onPressEnter={c.createNew}
          placeholder="例如 doc/note/idea.md"
          data-loc="explore:file:new:path"
        />
      </Modal>
    </div>
  );
}

/** 手機單窗格用:樹(Drawer)+ 預覽合一。 */
export default function Explore({ repo }: { repo: string }) {
  return (
    <ExploreProvider repo={repo}>
      <div style={{ display: 'flex', height: '100%' }} data-loc="explore:root">
        <ExploreTree />
        <div style={{ flex: 1, minWidth: 0 }}>
          <ExplorePreview />
        </div>
      </div>
    </ExploreProvider>
  );
}
