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
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import {
  Tree,
  Empty,
  Spin,
  Alert,
  Grid,
  Drawer,
  Button,
  Typography,
  Input,
  Modal,
  Space,
  Popconfirm,
} from 'antd';
import type { TreeDataNode } from 'antd';
import {
  MenuOutlined,
  EditOutlined,
  SaveOutlined,
  CloseOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  UploadOutlined,
  LeftOutlined,
  RightOutlined,
  ReloadOutlined,
  DeleteOutlined,
  HighlightOutlined,
  FolderOutlined,
  FileOutlined,
} from '@ant-design/icons';
import { api } from '../lib/api';
import Markdown from '../components/Markdown';
import { setCurrentFile } from '../lib/currentFile';

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

/** repo 相對路徑的上層目錄('doc/note/a.md' → 'doc/note';'a.md' → '')。 */
const parentDir = (p: string) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};
/** 接 dir + name(dir 為空 = repo root)。 */
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** 路徑最後一段。 */
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** File → base64(去掉 data: 前綴),供上傳走 PUT encoding=base64。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      resolve(res.slice(res.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 重抓整棵樹:根層 + 對「目前展開」的資料夾遞迴補抓 children(供 refresh 用)。 */
async function fetchTreeWithExpanded(repo: string, expanded: Set<string>): Promise<Node[]> {
  const build = async (rel: string): Promise<Node[]> => {
    const r = await api.tree(repo, rel || '.');
    const nodes = r.items.map(toNode);
    for (const n of nodes) {
      if (!n.isLeaf && expanded.has(n.path)) {
        n.children = await build(n.path);
      }
    }
    return nodes;
  };
  return build('');
}

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
  expandedKeys: React.Key[];
  setExpandedKeys: (k: React.Key[]) => void;
  loadedKeys: React.Key[];
  setLoadedKeys: (k: React.Key[]) => void;
  err: string | null;
  sel: Selected | null;
  selPath: string | null;
  selectedKeys: React.Key[]; // 樹反白(導航 / 點選同步)
  folderView: { path: string; items: Node[]; readmePath: string | null; readme: string | null } | null;
  openPath: (path: string) => void; // 導航到 repo 內路徑(grid 點擊 / 程式導航)
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
  baseDir: string; // 新增/上傳的所在目錄(依選取節點)
  newOpen: boolean;
  setNewOpen: (b: boolean) => void;
  newPath: string;
  setNewPath: (s: string) => void;
  newDirOpen: boolean;
  setNewDirOpen: (b: boolean) => void;
  newDirName: string;
  setNewDirName: (s: string) => void;
  renameOpen: boolean;
  setRenameOpen: (b: boolean) => void;
  renameName: string;
  setRenameName: (s: string) => void;
  beginRename: (path: string) => void;
  commitRename: () => void;
  removePath: (path: string) => void;
  treeMin: boolean;
  setTreeMin: (b: boolean) => void;
  onLoadData: (node: TreeDataNode) => Promise<void>;
  onSelect: (keys: React.Key[], info: { node: TreeDataNode }) => void;
  refresh: () => void;
  startEdit: () => void;
  cancelEdit: () => void;
  save: () => void;
  createNew: () => void;
  createDir: () => void;
  uploadFiles: (files: FileList) => void;
}

const Ctx = createContext<ExploreCtx | null>(null);

function useExplore(): ExploreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useExplore 必須在 <ExploreProvider> 內使用');
  return c;
}

export function ExploreProvider({ repo, children }: { repo: string; children: ReactNode }) {
  const [tree, setTree] = useState<Node[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Selected | null>(null);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  // 選資料夾時中央顯示:該夾內容 grid + README(若有)。選檔時為 null。
  const [folderView, setFolderView] = useState<{
    path: string;
    items: Node[];
    readmePath: string | null;
    readme: string | null;
  } | null>(null);
  const pendingNavRef = useRef<{ path: string; tab?: string } | null>(null); // 跨 repo 連結待開
  const didInitNav = useRef(false); // 初次載入是否已依 URL 開檔
  const [loadingFile, setLoadingFile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // draftRef:同步保存最新內容,供 window 'porthole:save-file' 事件(GUI Ctrl+S)即時存檔,
  // 不受 React state 非同步影響(CM6 onChange 同步更新此 ref)。
  const draftRef = useRef('');
  const setDraftSync = useCallback((v: string) => {
    draftRef.current = v;
    setDraft(v);
  }, []);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameTarget, setRenameTarget] = useState('');
  const [baseDir, setBaseDir] = useState(''); // 選資料夾 → 該夾;選檔 → 其父夾;預設 root
  const [treeMin, setTreeMin] = useState(false);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  // 重載樹但保留目前展開:對展開的資料夾遞迴重抓 children,並同步 loadedKeys
  // (否則 antd 視展開節點為已載入,新節點無 children → 顯示空,即 refresh bug)。
  const reloadTree = async () => {
    const expanded = new Set(expandedKeys.map(String));
    try {
      const nodes = await fetchTreeWithExpanded(repo, expanded);
      setTree(nodes);
      setLoadedKeys(Array.from(expanded));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    setTree([]);
    setSel(null);
    setSelPath(null);
    setSelectedKeys([]);
    setCurrentFile(null);
    setBaseDir('');
    setExpandedKeys([]);
    setLoadedKeys([]);
    setEditing(false);
    setErr(null);
    // 換 repo:直接抓根層(展開狀態已清空,不能用 reloadTree 的舊 closure)
    api
      .tree(repo, '.')
      .then((r) => {
        setTree(r.items.map(toNode));
        // 載根後:跨 repo 連結的待開目標 > 初次載入時 URL 內的 file path(deep-link)。
        let want = pendingNavRef.current;
        pendingNavRef.current = null;
        if (!want && !didInitNav.current) {
          const segs = location.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
          if (segs.length > 1) {
            want = { path: segs.slice(1).join('/'), tab: location.hash.replace(/^#/, '') || undefined };
          }
        }
        didInitNav.current = true;
        if (want?.path) void navigateTo(want.path, want.tab);
      })
      .catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const onLoadData = async (node: TreeDataNode): Promise<void> => {
    const n = node as Node;
    if (n.children || n.isLeaf) return;
    const r = await api.tree(repo, n.path);
    const children = r.items.map(toNode);
    setTree((prev) => updateChildren(prev, n.key as string, children));
  };

  // 把網址列同步成 /<repo>/<path>#<tab>(雙向 deep-link 用)。
  const writeUrl = useCallback(
    (path: string, tab?: string) => {
      const TABS = ['explore', 'chat', 'session', 'cli'];
      const t = tab && TABS.includes(tab) ? tab : location.hash.replace(/^#/, '') || 'explore';
      const enc = path.split('/').map(encodeURIComponent).join('/');
      history.replaceState(null, '', `/${encodeURIComponent(repo)}/${enc}#${t}`);
    },
    [repo],
  );

  // 載入資料夾視圖:該夾 children(grid)+ README.md(若有,case-insensitive)。
  const loadFolderView = useCallback(
    async (path: string) => {
      setLoadingFile(true);
      setErr(null);
      setEditing(false);
      setSel(null); // 清檔案預覽 → 改顯示資料夾視圖
      try {
        const r = await api.tree(repo, path);
        const items = r.items.map(toNode);
        if (path) setTree((prev) => updateChildren(prev, path, items)); // 同步進樹(展開可見)
        const readmeNode = items.find((n) => n.isLeaf && /^readme\.md$/i.test(String(n.title)));
        let readme: string | null = null;
        let readmePath: string | null = null;
        if (readmeNode) {
          try {
            const f = await api.file(repo, readmeNode.path);
            readme = f.content;
            readmePath = readmeNode.path;
          } catch {
            /* README 載不到 → 只顯示 grid */
          }
        }
        setFolderView({ path, items, readmePath, readme });
        // README 連結相對解析基準 + ContentPick 行號:指向 README。
        setCurrentFile(readmePath && readme != null ? { path: readmePath, content: readme } : null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoadingFile(false);
      }
    },
    [repo],
  );

  const onSelect = async (_keys: React.Key[], info: { node: TreeDataNode }) => {
    const n = info.node as Node;
    setSelPath(n.path);
    setSelectedKeys([n.path]);
    setBaseDir(n.isLeaf ? parentDir(n.path) : n.path); // 選檔→父夾;選資料夾→該夾
    writeUrl(n.path); // 點選即同步網址列(deep-link)
    if (!n.isLeaf) {
      void loadFolderView(n.path); // 資料夾:中央顯示 grid + README
      return;
    }
    setFolderView(null); // 選檔 → 清資料夾視圖
    setLoadingFile(true);
    setErr(null);
    setEditing(false);
    setSaveErr(null);
    setNote(null);
    try {
      const f = await api.file(repo, n.path);
      setSel({ path: n.path, content: f.content, markdown: f.markdown });
      setCurrentFile({ path: n.path, content: f.content }); // 供 ContentPick 推算行號
      setDrawerOpen(false); // 手機:選檔後關抽屜露出預覽
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingFile(false);
    }
  };

  // 逐層載入 + 展開祖先目錄(lazy tree),讓深層目標可被展開反白。
  const revealAncestors = useCallback(
    async (path: string) => {
      const parts = path.split('/').filter(Boolean);
      const ancestors: string[] = [];
      for (let i = 0; i < parts.length - 1; i++) ancestors.push(parts.slice(0, i + 1).join('/'));
      for (const dir of ancestors) {
        try {
          const r = await api.tree(repo, dir);
          setTree((prev) => updateChildren(prev, dir, r.items.map(toNode)));
        } catch {
          /* 略過載不到的層 */
        }
      }
      if (ancestors.length) {
        setLoadedKeys((k) => Array.from(new Set([...k.map(String), ...ancestors])));
        setExpandedKeys((k) => Array.from(new Set([...k.map(String), ...ancestors])));
      }
    },
    [repo],
  );

  /** 導航到 repo 內路徑:先試當檔案開,失敗試當資料夾展開;都不行 → 錯誤。並同步網址列。 */
  const navigateTo = useCallback(
    async (rawPath: string, tab?: string) => {
      const p = rawPath.replace(/^\/+|\/+$/g, '');
      if (!p) return;
      // 檔案
      try {
        const f = await api.file(repo, p);
        setFolderView(null);
        setEditing(false);
        setErr(null);
        setSel({ path: p, content: f.content, markdown: f.markdown });
        setCurrentFile({ path: p, content: f.content });
        setSelPath(p);
        setBaseDir(parentDir(p));
        setDrawerOpen(false);
        await revealAncestors(p);
        setSelectedKeys([p]);
        writeUrl(p, tab);
        return;
      } catch {
        /* 不是檔案 → 試資料夾 */
      }
      // 資料夾:展開 + 反白 + 中央顯示 grid + README(不開檔)
      try {
        await revealAncestors(p);
        setLoadedKeys((k) => Array.from(new Set([...k.map(String), p])));
        setExpandedKeys((k) => Array.from(new Set([...k.map(String), p])));
        setSelPath(p);
        setSelectedKeys([p]);
        setBaseDir(p);
        await loadFolderView(p); // 內含 setTree 子節點 + README
        writeUrl(p, tab);
      } catch {
        setErr(`找不到連結目標:${p}`);
      }
    },
    [repo, revealAncestors, writeUrl, loadFolderView],
  );

  // 連結點擊導航(MarkdownEditor 派 porthole:navigate)。跨 repo → 暫存,待 repo 換好再開。
  useEffect(() => {
    const onNav = (e: Event) => {
      const d = (e as CustomEvent).detail as { repo?: string; path?: string; tab?: string };
      if (!d?.path) return; // 純切 tab(無 path)交給 App 處理
      if (d.repo && d.repo !== repo) {
        pendingNavRef.current = { path: d.path, tab: d.tab };
        return; // App 會 setRepo;換好後由 repo 變更 effect 接手開檔
      }
      void navigateTo(d.path, d.tab);
    };
    window.addEventListener('porthole:navigate', onNav);
    return () => window.removeEventListener('porthole:navigate', onNav);
  }, [repo, navigateTo]);

  const startEdit = () => {
    if (!sel) return;
    setDraftSync(sel.content);
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

  // GUI 編輯器 Ctrl+S / 儲存:dispatch window 'porthole:save-file' → 存到磁碟但「不退出編輯」
  // (與 save() 不同,save() 會 setEditing(false))。讀 draftRef 取最新內容(避免 state 非同步)。
  useEffect(() => {
    if (!editing || !sel) return;
    const onSaveFile = () => {
      void (async () => {
        setSaving(true);
        setSaveErr(null);
        try {
          await api.writeFile(repo, sel.path, draftRef.current);
          setSel({ path: sel.path, content: draftRef.current, markdown: sel.markdown, isNew: false });
          setNote(`已儲存 ${sel.path}`);
        } catch (e) {
          setSaveErr((e as Error).message);
        } finally {
          setSaving(false);
        }
      })();
    };
    window.addEventListener('porthole:save-file', onSaveFile);
    return () => window.removeEventListener('porthole:save-file', onSaveFile);
  }, [editing, sel, repo]);

  // 重新整理:重載樹;若有開啟檔且非編輯中,重抓內容(看 agent 改後的結果)。
  const refresh = () => {
    reloadTree();
    if (sel && !editing) {
      const path = sel.path;
      api
        .file(repo, path)
        .then((f) => setSel({ path, content: f.content, markdown: f.markdown }))
        .catch((e: Error) => setErr(e.message));
    }
  };

  // 新檔:只填名,建在 baseDir 下(可含子路徑)。
  const createNew = () => {
    const name = newPath.trim().replace(/^[/\\]+/, '');
    if (!name) return;
    const p = joinPath(baseDir, name);
    setNewOpen(false);
    setNewPath('');
    setDrawerOpen(false);
    setErr(null);
    setNote(null);
    setSaveErr(null);
    setSel({ path: p, content: '', markdown: isMd(p), isNew: true });
    setSelPath(p);
    setDraftSync('');
    setEditing(true);
  };

  // 新增目錄:名 → baseDir/名。
  const createDir = async () => {
    const name = newDirName.trim().replace(/^[/\\]+/, '');
    if (!name) return;
    const p = joinPath(baseDir, name);
    setNewDirOpen(false);
    setNewDirName('');
    setDrawerOpen(false);
    setErr(null);
    setNote(null);
    try {
      await api.makeDir(repo, p);
      reloadTree();
      setNote(`已建目錄 ${p}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // 改名 / 刪除(同層改名;刪除目錄連內容)。受影響的開啟檔同步更新。
  const beginRename = (p: string) => {
    setRenameTarget(p);
    setRenameName(basename(p));
    setRenameOpen(true);
  };
  const commitRename = async () => {
    const name = renameName.trim().replace(/^[/\\]+/, '');
    const from = renameTarget;
    if (!name || !from) return;
    const to = joinPath(parentDir(from), name);
    setRenameOpen(false);
    if (to === from) return;
    setErr(null);
    setNote(null);
    try {
      await api.renamePath(repo, from, to);
      if (sel && sel.path === from) {
        setSel({ ...sel, path: to });
        setSelPath(to);
      } else if (selPath === from) {
        setSelPath(to);
      }
      reloadTree();
      setNote(`已改名 → ${to}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const removePath = async (p: string) => {
    setErr(null);
    setNote(null);
    try {
      await api.deletePath(repo, p);
      if (sel && (sel.path === p || sel.path.startsWith(`${p}/`))) setSel(null);
      if (selPath && (selPath === p || selPath.startsWith(`${p}/`))) setSelPath(null);
      reloadTree();
      setNote(`已刪除 ${p}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // 上傳:多檔 → 各讀成 base64 PUT 到 baseDir 下(同新增檔邏輯,走 path-guard)。
  const uploadFiles = async (files: FileList) => {
    setErr(null);
    setNote(null);
    try {
      let n = 0;
      for (const f of Array.from(files)) {
        const b64 = await fileToBase64(f);
        await api.writeFile(repo, joinPath(baseDir, f.name), b64, 'base64');
        n++;
      }
      reloadTree();
      setNote(`已上傳 ${n} 個檔到 ${baseDir || repo}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const value: ExploreCtx = {
    repo,
    isMobile,
    tree,
    expandedKeys,
    setExpandedKeys,
    loadedKeys,
    setLoadedKeys,
    err,
    sel,
    selPath,
    selectedKeys,
    folderView,
    openPath: (p: string) =>
      window.dispatchEvent(new CustomEvent('porthole:navigate', { detail: { repo, path: p } })),
    loadingFile,
    drawerOpen,
    setDrawerOpen,
    editing,
    draft,
    setDraft: setDraftSync,
    saving,
    saveErr,
    note,
    setNote,
    baseDir,
    newOpen,
    setNewOpen,
    newPath,
    setNewPath,
    newDirOpen,
    setNewDirOpen,
    newDirName,
    setNewDirName,
    renameOpen,
    setRenameOpen,
    renameName,
    setRenameName,
    beginRename,
    commitRename: () => void commitRename(),
    removePath: (p: string) => void removePath(p),
    treeMin,
    setTreeMin,
    onLoadData,
    onSelect,
    refresh,
    startEdit,
    cancelEdit,
    save: () => void save(),
    createNew,
    createDir: () => void createDir(),
    uploadFiles: (files: FileList) => void uploadFiles(files),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 檔案樹面板(新檔 / 最小化鈕 + Tree)。 */
function TreePanel() {
  const c = useExplore();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <Space.Compact>
          <Button
            icon={<FileAddOutlined />}
            onClick={() => c.setNewOpen(true)}
            title="新檔(在所在目錄)"
            data-loc="explore:file:new"
          />
          <Button
            icon={<FolderAddOutlined />}
            onClick={() => c.setNewDirOpen(true)}
            title="新增目錄(在所在目錄)"
            data-loc="explore:dir:new"
          />
          <Button
            icon={<UploadOutlined />}
            onClick={() => fileRef.current?.click()}
            title="上傳檔案(到所在目錄)"
            data-loc="explore:file:upload"
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={c.refresh}
            title="重新整理(看 agent 改後結果)"
            data-loc="explore:tree:refresh"
          />
          <Button
            icon={<HighlightOutlined />}
            onClick={() => window.dispatchEvent(new Event('porthole:pick:start'))}
            title="引用內容:點檔案 / 內容 → 複製引用到剪貼簿(Cursor 式)"
            data-loc="explore:pick"
          />
        </Space.Compact>
        {!c.isMobile && (
          <Button
            icon={<LeftOutlined />}
            onClick={() => c.setTreeMin(true)}
            title="最小化檔案樹"
            data-loc="explore:tree:minimize"
          />
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) c.uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Typography.Text
        type="secondary"
        ellipsis
        style={{ fontSize: 11, display: 'block', marginBottom: 8 }}
        title={c.baseDir || '/'}
      >
        位置:{c.baseDir || '/'}
      </Typography.Text>
      {c.err && <Alert type="error" message={c.err} style={{ marginBottom: 8 }} />}
      {c.tree.length === 0 && !c.err ? (
        <Spin />
      ) : (
        <Tree.DirectoryTree
          className="ph-tree"
          treeData={c.tree}
          loadData={c.onLoadData}
          onSelect={c.onSelect}
          selectedKeys={c.selectedKeys}
          expandedKeys={c.expandedKeys}
          onExpand={(keys) => c.setExpandedKeys(keys)}
          loadedKeys={c.loadedKeys}
          onLoad={(keys) => c.setLoadedKeys(keys)}
          blockNode
          titleRender={(node) => {
            const n = node as Node;
            return (
              // data-path / data-leaf:供「引用內容」挑選器(ContentPick)從樹上取檔案路徑。
              <span className="ph-row" data-path={n.path} data-leaf={n.isLeaf ? '1' : '0'}>
                <span className="ph-row-name">{n.title as React.ReactNode}</span>
                <span className="ph-row-actions" onClick={(e) => e.stopPropagation()}>
                  <EditOutlined
                    title="改名"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.beginRename(n.path);
                    }}
                  />
                  <Popconfirm
                    title={`刪除 ${n.title}?${n.isLeaf ? '' : '(資料夾連內容)'}`}
                    okText="刪除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => c.removePath(n.path)}
                  >
                    <DeleteOutlined
                      title="刪除"
                      style={{ color: '#cf1322' }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </span>
              </span>
            );
          }}
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
      data-file={c.sel?.path || c.folderView?.readmePath || undefined}
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
        ) : c.folderView ? (
          <div data-loc="explore:folder">
            {c.folderView.items.length === 0 ? (
              <Empty description="空資料夾" />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: 8,
                }}
              >
                {[...c.folderView.items]
                  .sort((a, b) =>
                    a.isLeaf === b.isLeaf
                      ? String(a.title).localeCompare(String(b.title))
                      : a.isLeaf
                        ? 1
                        : -1,
                  )
                  .map((it) => (
                    <div
                      key={it.path}
                      onClick={() => c.openPath(it.path)}
                      title={it.path}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '10px 12px',
                        border: '1px solid #f0f0f0',
                        borderRadius: 8,
                        cursor: 'pointer',
                        overflow: 'hidden',
                      }}
                      data-loc="explore:folder:item"
                    >
                      {it.isLeaf ? (
                        <FileOutlined style={{ color: '#888' }} />
                      ) : (
                        <FolderOutlined style={{ color: '#1677ff' }} />
                      )}
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {String(it.title)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {c.folderView.readme != null && (
              <div
                className="md-preview"
                style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}
              >
                <Markdown>{c.folderView.readme}</Markdown>
              </div>
            )}
          </div>
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
          在 <Typography.Text code>{c.baseDir || `${c.repo}/`}</Typography.Text> 下新增(可含子路徑,中間目錄自動建立)。
        </Typography.Paragraph>
        <Input
          value={c.newPath}
          onChange={(e) => c.setNewPath(e.target.value)}
          onPressEnter={c.createNew}
          placeholder="例如 idea.md"
          data-loc="explore:file:new:path"
        />
      </Modal>

      <Modal
        title="新增目錄"
        open={c.newDirOpen}
        onOk={c.createDir}
        onCancel={() => {
          c.setNewDirOpen(false);
          c.setNewDirName('');
        }}
        okText="建立"
        cancelText="取消"
        okButtonProps={{ disabled: !c.newDirName.trim() }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          在 <Typography.Text code>{c.baseDir || `${c.repo}/`}</Typography.Text> 下新增目錄(可含子路徑)。
        </Typography.Paragraph>
        <Input
          value={c.newDirName}
          onChange={(e) => c.setNewDirName(e.target.value)}
          onPressEnter={c.createDir}
          placeholder="例如 note"
          data-loc="explore:dir:new:name"
        />
      </Modal>

      <Modal
        title="改名"
        open={c.renameOpen}
        onOk={c.commitRename}
        onCancel={() => c.setRenameOpen(false)}
        okText="改名"
        cancelText="取消"
        okButtonProps={{ disabled: !c.renameName.trim() }}
      >
        <Input
          value={c.renameName}
          onChange={(e) => c.setRenameName(e.target.value)}
          onPressEnter={c.commitRename}
          placeholder="新名稱(同層)"
          data-loc="explore:rename:input"
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
