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
  TreeSelect,
  AutoComplete,
  Table,
  Segmented,
} from 'antd';
import type { TreeDataNode } from 'antd';
import type { ColumnsType } from 'antd/es/table';
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
  DragOutlined,
  AppstoreOutlined,
  BarsOutlined,
  DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { api, type TreeItem, type SearchFile } from '../lib/api';
import Markdown from '../components/Markdown';
import EnvView from '../components/EnvView';
import Outline, { headingLineNumbers } from '../components/Outline';
import type { MarkdownEditorHandle } from '../components/MarkdownEditor';
import { scrollToHeadingSlug } from '../lib/heading';
import { setCurrentFile } from '../lib/currentFile';

// CM6 編輯器較重 → lazy load(守「薄」)。mermaid/FlowEditor 在 MermaidBlock 內按需載入。
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor'));
const ExcalidrawEditor = lazy(() => import('../components/ExcalidrawEditor'));

type Node = TreeDataNode & { path: string; isLeaf: boolean };

interface Selected {
  path: string;
  content: string;
  markdown: boolean;
  isNew?: boolean; // 新檔尚未存到磁碟
  image?: boolean; // 圖片檔(以 <img> 預覽,不抓文字內容)
  excalidraw?: boolean; // .excalidraw 檔(自由白板,以 Excalidraw 編輯器開)
  env?: boolean; // .env 檔(預覽美化成 KEY/VALUE 表)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const isImage = (p: string) => IMAGE_EXT.test(p);
const isExcalidraw = (p: string) => /\.excalidraw$/i.test(p);
/** .env / .env.* / *.env(dotenv 類)→ 預覽走 EnvView 美化。 */
const isEnv = (p: string) => {
  const b = basename(p);
  return b === '.env' || b.startsWith('.env.') || /\.env$/i.test(b);
};

function toNode(item: { name: string; path: string; type: 'dir' | 'file' }): Node {
  return {
    title: item.name,
    key: item.path,
    path: item.path,
    isLeaf: item.type === 'file',
  };
}

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

/** bytes → 人性化(資料夾傳 undefined → '—')。 */
function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** mtime(ms) → 'YYYY-MM-DD HH:mm'。 */
function fmtMtime(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 貼上圖片自動檔名用的時間戳:YYYYMMDD-HHMMSS。 */
function pasteStamp(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 圖片 MIME → 副檔名。 */
function imageExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/svg+xml') return 'svg';
  const slash = m.indexOf('/');
  const sub = slash === -1 ? '' : m.slice(slash + 1);
  return /^[a-z0-9]+$/.test(sub) ? sub : 'png';
}

type FolderMode = 'grid' | 'list';
const FOLDER_MODE_KEY = 'porthole:folderMode';
function readFolderMode(): FolderMode {
  try {
    return localStorage.getItem(FOLDER_MODE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * preview 捲動容器頂端「當前 section」的 heading 序號(第 N 個 heading,0-based)。
 * 用來把 preview 捲動位置延續到編輯器。無 heading 或都在下方 → 0(頂端)。
 */
function previewTopHeadingIndex(): number {
  const scroller = document.querySelector('[data-loc="explore:preview:scroll"]');
  const preview = scroller?.querySelector('.md-preview');
  if (!scroller || !preview) return 0;
  const heads = preview.querySelectorAll('h1,h2,h3,h4,h5,h6');
  if (heads.length === 0) return 0;
  const top = scroller.getBoundingClientRect().top;
  const tol = 4;
  let idx = 0;
  heads.forEach((h, i) => {
    if (h.getBoundingClientRect().top <= top + tol) idx = i;
  });
  return idx;
}

/** 觸發瀏覽器下載某檔(隱藏 a[download] 指向 attachment endpoint,path-guard 在後端)。 */
function triggerDownload(repo: string, filePath: string) {
  const a = document.createElement('a');
  a.href = api.downloadUrl(repo, filePath);
  a.download = filePath.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 檔名副檔名(小寫,無點);無副檔名回 ''。 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 資料夾視圖 list 模式:仿檔案總管,顯示 名稱/修改時間/大小/類型,欄頭可排序。 */
function FolderTable({ entries, onOpen }: { entries: TreeItem[]; onOpen: (p: string) => void }) {
  const columns: ColumnsType<TreeItem> = [
    {
      title: '名稱',
      dataIndex: 'name',
      ellipsis: true,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_v, r) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {r.type === 'dir' ? (
            <FolderOutlined style={{ color: '#1677ff', flexShrink: 0 }} />
          ) : (
            <FileOutlined style={{ color: '#888', flexShrink: 0 }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.name}
          </span>
        </span>
      ),
    },
    {
      title: '修改時間',
      dataIndex: 'mtime',
      width: 160,
      sorter: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0),
      render: (v: number | undefined) => (
        <span style={{ color: '#888', whiteSpace: 'nowrap' }}>{fmtMtime(v)}</span>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.size ?? -1) - (b.size ?? -1),
      render: (v: number | undefined) => (
        <span style={{ color: '#888', whiteSpace: 'nowrap' }}>{fmtBytes(v)}</span>
      ),
    },
    {
      title: '類型',
      dataIndex: 'type',
      width: 100,
      sorter: (a, b) => (a.type === b.type ? extOf(a.name).localeCompare(extOf(b.name)) : a.type === 'dir' ? -1 : 1),
      render: (_v, r) => (r.type === 'dir' ? '資料夾' : extOf(r.name).toUpperCase() || '檔案'),
    },
  ];
  return (
    <div data-loc="explore:folder:list">
      <Table<TreeItem>
        rowKey="path"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={entries}
        onRow={(r) => ({
          onClick: () => onOpen(r.path),
          style: { cursor: 'pointer' },
        })}
      />
    </div>
  );
}

/** repo 相對路徑的上層目錄('doc/note/a.md' → 'doc/note';'a.md' → '')。 */
const parentDir = (p: string) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};
/** 接 dir + name(dir 為空 = repo root)。 */
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** 路徑最後一段。 */
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// 新增檔:打 `.` 後的副檔名 smart hint(VSCode 式)。md / excalidraw 優先。
const FILE_EXTS: { ext: string; desc: string }[] = [
  { ext: 'md', desc: 'Markdown' },
  { ext: 'excalidraw', desc: '白板(Excalidraw)' },
  { ext: 'txt', desc: '純文字' },
  { ext: 'json', desc: 'JSON' },
  { ext: 'env', desc: '環境變數(.env)' },
  { ext: 'd2', desc: 'D2 圖' },
  { ext: 'yaml', desc: 'YAML' },
  { ext: 'yml', desc: 'YAML' },
  { ext: 'csv', desc: 'CSV' },
  { ext: 'sh', desc: 'Shell' },
];
/** 依目前輸入,對「最後一段檔名的副檔名」出提示;沒打 `.`(或 . 在最前的隱藏檔)則不提示。 */
function extOptions(input: string): { value: string; label: ReactNode }[] {
  const slash = input.lastIndexOf('/');
  const dir = slash === -1 ? '' : input.slice(0, slash + 1);
  const name = input.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return []; // 沒副檔名分隔,或 . 在最前(隱藏檔)→ 不提示
  const base = name.slice(0, dot);
  const partial = name.slice(dot + 1).toLowerCase();
  return FILE_EXTS.filter(({ ext }) => ext.startsWith(partial))
    .map(({ ext, desc }) => ({ value: `${dir}${base}.${ext}`, ext, desc }))
    .filter((o) => o.value !== input) // 已補完(完全相符)→ 不再提示,讓 Enter 直接建立
    .map((o) => ({
      value: o.value,
      label: (
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace' }}>.{o.ext}</span>
          <span style={{ color: '#999', fontSize: 12 }}>{o.desc}</span>
        </span>
      ),
    }));
}

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

// 「移動到資料夾」選擇器:只列資料夾的 lazy 樹(antd TreeSelect)。
// ROOT_DIR 哨符代表 repo 根目錄(避免空字串在 TreeSelect 被當「未選」的邊界問題)。
const ROOT_DIR = ' root';
type DirTreeNode = {
  title: ReactNode;
  value: string;
  key: string;
  isLeaf: boolean;
  selectable: boolean;
  disabled?: boolean;
  children?: DirTreeNode[];
};
/** 目錄 → 選擇樹節點;若正移動資料夾,擋掉它自己與子孫(不可移進自身)。 */
function dirToTreeNode(item: { name: string; path: string }, movingPath: string): DirTreeNode {
  const blocked = item.path === movingPath || item.path.startsWith(`${movingPath}/`);
  return {
    title: item.name,
    value: item.path,
    key: item.path,
    isLeaf: false, // 不預判有無子夾 → 留展開箭頭,展開時 loadData 補抓
    selectable: !blocked,
    disabled: blocked,
  };
}
/** 不可變更新選擇樹中某 value 的 children。 */
function updateDirChildren(nodes: DirTreeNode[], value: string, children: DirTreeNode[]): DirTreeNode[] {
  return nodes.map((n) => {
    if (n.value === value) return { ...n, children };
    if (n.children) return { ...n, children: updateDirChildren(n.children, value, children) };
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
  folderView: {
    path: string;
    items: Node[];
    entries: TreeItem[]; // 原始項目(含 mtime/size),供 list 模式與排序用
    readmePath: string | null;
    readme: string | null;
  } | null;
  folderMode: FolderMode; // 資料夾視圖:grid / list(記 localStorage)
  setFolderMode: (m: FolderMode) => void;
  openPath: (path: string) => void; // 導航到 repo 內路徑(grid 點擊 / 程式導航)
  reloadSeq: number; // refresh 重載序號(編輯器 key / 圖片 cache-bust)
  saveFileContent: (content: string) => Promise<void>; // 直接寫檔(Excalidraw 存檔)
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
  downloadFile: (path: string) => void; // 下載某檔(預覽列 / 樹節點)
  // 移動到資料夾(沿用後端 rename 端點,純換目錄)
  moveOpen: boolean;
  setMoveOpen: (b: boolean) => void;
  moveTarget: string; // 正在移動的來源路徑
  moveDest: string; // 已選目標資料夾('' = 尚未選;ROOT_DIR = repo 根)
  setMoveDest: (s: string) => void;
  moveTree: DirTreeNode[];
  moveTo: string; // 預計新路徑(目標夾 + 原檔名);未選時為 ''
  beginMove: (path: string) => void;
  commitMove: () => void;
  onMoveLoadData: (node: { value?: React.Key }) => Promise<void>;
  treeMin: boolean;
  setTreeMin: (b: boolean) => void;
  // VSCode 式多分頁(active = selPath)
  openTabs: string[];
  activateTab: (path: string) => void;
  closeTab: (path: string) => void;
  // 內容搜尋(Eclipse Ctrl+H 式;左側樹面板內切換)
  searchMode: boolean;
  setSearchMode: (b: boolean) => void;
  searchQ: string;
  setSearchQ: (s: string) => void;
  searchRegex: boolean;
  setSearchRegex: (b: boolean) => void;
  searchCase: boolean;
  setSearchCase: (b: boolean) => void;
  searchResults: SearchFile[];
  searchLoading: boolean;
  searchErr: string | null;
  searchTruncated: boolean;
  searchRan: boolean;
  runSearch: () => void;
  openHit: (path: string, line: number) => void; // 點搜尋結果 → 開檔並(md)跳到該行
  onLoadData: (node: TreeDataNode) => Promise<void>;
  onSelect: (keys: React.Key[], info: { node: TreeDataNode }) => void;
  refresh: () => void;
  editInitialLine: number; // 進編輯時初始捲到的行(延續 preview 捲動位置)
  editorRef: React.RefObject<MarkdownEditorHandle | null>; // 編輯器 handle(退編輯讀頂端行)
  pasteEditorImage: (file: File) => Promise<string | null>; // 編輯器貼圖 → 存檔回傳相對名
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
    entries: TreeItem[];
    readmePath: string | null;
    readme: string | null;
  } | null>(null);
  const [folderMode, setFolderModeState] = useState<FolderMode>(readFolderMode);
  const setFolderMode = useCallback((m: FolderMode) => {
    setFolderModeState(m);
    try {
      localStorage.setItem(FOLDER_MODE_KEY, m);
    } catch {
      /* localStorage 不可用 → 僅記憶體 */
    }
  }, []);
  const editInitialLineRef = useRef(0); // 進編輯前算好的初始行(延續 preview 捲動位置)
  const editorRef = useRef<MarkdownEditorHandle>(null); // 讀編輯器頂端行(退編輯帶回 preview)
  const pendingExitHeadingRef = useRef<number | null>(null); // 退編輯後 preview 要捲到的 heading 序號(-1=頂)
  // paste handler 走 document 監聽 → 用 ref 讀最新「選中的資料夾」,避免閉包舊值。
  const folderViewRef = useRef(folderView);
  useEffect(() => {
    folderViewRef.current = folderView;
  }, [folderView]);
  // VSCode 式多分頁:開啟的檔案路徑清單(有序);active = selPath。
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const selPathRef = useRef<string | null>(null); // noteOpenTab「取代目前分頁」需讀切換前的 active
  useEffect(() => {
    selPathRef.current = selPath;
  }, [selPath]);

  // 記錄開啟某檔為分頁。mode='new':累積新分頁(Ctrl+click / tree 點檔);
  // mode='active':取代目前 active 分頁(一般點 link)。已開的檔一律去重(只切換不重複)。
  const noteOpenTab = useCallback((path: string, mode: 'active' | 'new') => {
    setOpenTabs((prev) => {
      if (prev.includes(path)) return prev; // 已開 → 列表不動(呼叫端會切為 active)
      const activeIdx = prev.indexOf(selPathRef.current ?? '');
      if (mode === 'new' || activeIdx < 0) return [...prev, path];
      const next = [...prev];
      next[activeIdx] = path; // 取代目前 active 那格
      return next;
    });
  }, []);
  const pendingNavRef = useRef<{ path: string; tab?: string; section?: string } | null>(null); // 跨 repo 連結待開
  const didInitNav = useRef(false); // 初次載入是否已依 URL 開檔
  const [reloadSeq, setReloadSeq] = useState(0); // refresh 重載編輯器/圖片(換 key / cache-bust)
  const [loadingFile, setLoadingFile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // 內容搜尋(Ctrl+H;樹面板內切換)
  const [searchMode, setSearchMode] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchCase, setSearchCase] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchFile[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchRan, setSearchRan] = useState(false);
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
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const moveTargetRef = useRef(''); // 供 lazy loadData 內判斷可否選(避免 closure 過期)
  const [moveDest, setMoveDest] = useState(''); // '' = 尚未選
  const [moveTree, setMoveTree] = useState<DirTreeNode[]>([]);
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
    setOpenTabs([]); // 換 repo → 清分頁
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
            want = {
              path: segs.slice(1).join('/'),
              tab: location.hash.replace(/^#/, '') || undefined,
              section: new URLSearchParams(location.search).get('sec') || undefined, // deep-link 章節
            };
          }
        }
        didInitNav.current = true;
        if (want?.path) void navigateTo(want.path, want.tab, false, want.section); // 初次/deep-link → 不新增歷史
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

  // 把網址列同步成 /<repo>/<path>#<tab>。push=true → 新增歷史一筆(可上一頁);否則取代。
  const writeUrl = useCallback(
    (path: string, tab?: string, push = false, section?: string) => {
      const TABS = ['explore', 'chat', 'session', 'cli'];
      const t = tab && TABS.includes(tab) ? tab : location.hash.replace(/^#/, '') || 'explore';
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const sec = section ? `?sec=${encodeURIComponent(section)}` : '';
      const url = `/${encodeURIComponent(repo)}/${enc}${sec}#${t}`;
      if (push && location.pathname + location.search + location.hash !== url) {
        history.pushState(null, '', url);
      } else {
        history.replaceState(null, '', url);
      }
    },
    [repo],
  );

  // 開檔後把預覽捲到指定章節 slug。markdown 由 react-markdown 同步渲染,但存檔序 / 版面可能
  // 差一兩幀 → rAF 重試數次直到找到該標題。forPath:重試途中若預覽已換成別的檔(data-file
  // 不符)則中止,避免捲錯檔。
  const scrollSectionWhenReady = useCallback((slug: string, forPath: string) => {
    let tries = 0;
    const tick = () => {
      const shown = document
        .querySelector('[data-loc="explore:preview"]')
        ?.getAttribute('data-file');
      if (shown !== forPath) return; // 已導航到別的檔 → 放棄
      if (scrollToHeadingSlug(slug) || tries++ > 12) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  // 載入資料夾視圖:該夾 children(grid)+ README.md(若有,case-insensitive)。
  const loadFolderView = useCallback(
    async (path: string) => {
      setLoadingFile(true);
      setErr(null);
      setEditing(false);
      setSel(null); // 清檔案預覽 → 改顯示資料夾視圖
      try {
        const r = await api.tree(repo, path, true); // stat=1:list 模式要 mtime/size
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
        setFolderView({ path, items, entries: r.items, readmePath, readme });
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
    writeUrl(n.path, undefined, true); // 點選即同步網址列 + 留歷史(可上一頁)
    if (!n.isLeaf) {
      void loadFolderView(n.path); // 資料夾:中央顯示 grid + README
      return;
    }
    setFolderView(null); // 選檔 → 清資料夾視圖
    noteOpenTab(n.path, 'new'); // tree 點檔 → 開/切分頁(累積)
    setErr(null);
    setEditing(false);
    setSaveErr(null);
    setNote(null);
    // 圖片:不抓文字內容,直接以 <img> 預覽。
    if (isImage(n.path)) {
      setSel({ path: n.path, content: '', markdown: false, image: true });
      setCurrentFile(null);
      setDrawerOpen(false);
      return;
    }
    setLoadingFile(true);
    try {
      const f = await api.file(repo, n.path);
      setSel({ path: n.path, content: f.content, markdown: f.markdown, excalidraw: isExcalidraw(n.path), env: isEnv(n.path) });
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

  /** 導航到 repo 內路徑:先試當檔案開,失敗試當資料夾展開;都不行 → 錯誤。並同步網址列。
   *  push=true(連結 / grid 點擊)→ 留歷史可上一頁;false(deep-link 載入 / popstate)→ 取代。 */
  const navigateTo = useCallback(
    async (rawPath: string, tab?: string, push = true, section?: string, tabMode: 'active' | 'new' = 'active') => {
      const p = rawPath.replace(/^\/+|\/+$/g, '');
      if (!p) return;
      // 圖片:不抓文字,直接 <img> 預覽(圖片必為檔案)。
      if (isImage(p)) {
        noteOpenTab(p, tabMode);
        setFolderView(null);
        setEditing(false);
        setErr(null);
        setSel({ path: p, content: '', markdown: false, image: true });
        setCurrentFile(null);
        setSelPath(p);
        setBaseDir(parentDir(p));
        setDrawerOpen(false);
        await revealAncestors(p);
        setSelectedKeys([p]);
        writeUrl(p, tab, push);
        return;
      }
      // 檔案
      try {
        const f = await api.file(repo, p);
        noteOpenTab(p, tabMode);
        setFolderView(null);
        setEditing(false);
        setErr(null);
        setSel({ path: p, content: f.content, markdown: f.markdown, excalidraw: isExcalidraw(p), env: isEnv(p) });
        setCurrentFile({ path: p, content: f.content });
        setSelPath(p);
        setBaseDir(parentDir(p));
        setDrawerOpen(false);
        await revealAncestors(p);
        setSelectedKeys([p]);
        writeUrl(p, tab, push, section);
        if (section && f.markdown) scrollSectionWhenReady(section, p);
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
        writeUrl(p, tab, push);
      } catch {
        setErr(`找不到連結目標:${p}`);
      }
    },
    [repo, revealAncestors, writeUrl, loadFolderView, scrollSectionWhenReady, noteOpenTab],
  );

  // 切到某已開分頁(載入該檔)。noteOpenTab 去重故不會重複加。
  const activateTab = useCallback(
    (path: string) => {
      if (path === selPathRef.current) return;
      void navigateTo(path, undefined, true);
    },
    [navigateTo],
  );

  // 關閉某分頁;若關的是 active → 切到鄰居(右優先,無則左),都沒有 → 清空預覽。
  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx < 0) return prev;
        const next = prev.filter((p) => p !== path);
        if (path === selPathRef.current) {
          const nb = next[idx] ?? next[idx - 1] ?? null;
          if (nb) {
            void navigateTo(nb, undefined, true);
          } else {
            setSel(null);
            setSelPath(null);
            setSelectedKeys([]);
            setEditing(false);
            setCurrentFile(null);
          }
        }
        return next;
      });
    },
    [navigateTo],
  );

  // 跑內容搜尋(呼叫後端;結果依檔分組)。
  const runSearch = useCallback(async () => {
    const q = searchQ.trim();
    if (!q) {
      setSearchResults([]);
      setSearchRan(false);
      setSearchErr(null);
      return;
    }
    setSearchLoading(true);
    setSearchErr(null);
    try {
      const r = await api.search(repo, q, { regex: searchRegex, caseSensitive: searchCase });
      setSearchResults(r.results);
      setSearchTruncated(r.truncated);
      setSearchRan(true);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : '搜尋失敗');
      setSearchResults([]);
      setSearchTruncated(false);
      setSearchRan(true);
    } finally {
      setSearchLoading(false);
    }
  }, [repo, searchQ, searchRegex, searchCase]);

  // 點搜尋結果 → 開檔;markdown 進編輯器並捲到該行(preview 無任意行錨點,故用 CM6 initialLine)。
  const openHit = useCallback(
    async (p: string, line: number) => {
      await navigateTo(p, undefined, true);
      editInitialLineRef.current = Math.max(0, line - 1);
      setEditing(true);
    },
    [navigateTo],
  );

  // 連結點擊導航(MarkdownEditor 派 porthole:navigate)。跨 repo → 暫存,待 repo 換好再開。
  useEffect(() => {
    const onNav = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        repo?: string;
        path?: string;
        tab?: string;
        section?: string;
        newTab?: boolean; // Ctrl/Cmd+click md link → 開新分頁(否則取代目前分頁)
      };
      if (!d?.path) return; // 純切 tab(無 path)交給 App 處理
      if (d.repo && d.repo !== repo) {
        pendingNavRef.current = { path: d.path, tab: d.tab, section: d.section };
        return; // App 會 setRepo;換好後由 repo 變更 effect 接手開檔
      }
      void navigateTo(d.path, d.tab, true, d.section, d.newTab ? 'new' : 'active');
    };
    window.addEventListener('porthole:navigate', onNav);
    return () => window.removeEventListener('porthole:navigate', onNav);
  }, [repo, navigateTo]);

  // 上一頁 / 下一頁(popstate):依新 URL 重開檔案/資料夾(push=false,不再灌歷史)。
  useEffect(() => {
    const onPop = () => {
      const segs = location.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      if (segs[0] !== repo) return; // 跨 repo 交給 App(切 repo 後由 repo effect 接手)
      const path = segs.slice(1).join('/');
      if (path) {
        const sec = new URLSearchParams(location.search).get('sec') || undefined;
        void navigateTo(path, location.hash.replace(/^#/, '') || undefined, false, sec);
      } else {
        // 回到 repo 根(無 path)→ 清空中央視圖
        setSel(null);
        setFolderView(null);
        setSelPath(null);
        setSelectedKeys([]);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [repo, navigateTo]);

  const startEdit = () => {
    if (!sel) return;
    // 進編輯保持 preview 捲動位置:頂端可見 heading → 對應原始行(非 md 檔捲到頂)。
    if (sel.markdown) {
      const idx = previewTopHeadingIndex();
      const lines = headingLineNumbers(sel.content);
      editInitialLineRef.current = idx > 0 ? (lines[idx] ?? 0) : 0;
    } else {
      editInitialLineRef.current = 0;
    }
    setDraftSync(sel.content);
    setSaveErr(null);
    setNote(null);
    setEditing(true);
  };

  // 退編輯前:記住編輯器頂端所在的 heading 序號,回 preview 後捲到那(反向延續)。
  const rememberExitHeading = () => {
    if (!sel?.markdown || sel.isNew) {
      pendingExitHeadingRef.current = null;
      return;
    }
    const top0 = editorRef.current?.topLine() ?? 0;
    const hls = headingLineNumbers(draftRef.current);
    let n = -1;
    for (let i = 0; i < hls.length; i++) {
      if (hls[i] <= top0) n = i;
      else break;
    }
    pendingExitHeadingRef.current = n; // -1 = 頂端在首個 heading 之前
  };

  // 換檔(sel.path 變)→ 作廢殘留的退出捲動意圖,避免捲錯檔。
  useEffect(() => {
    pendingExitHeadingRef.current = null;
  }, [sel?.path]);

  // 退出編輯(editing → false)且有記錄 → preview 渲染後捲到對應第 N 個 heading。
  useEffect(() => {
    if (editing) return;
    const n = pendingExitHeadingRef.current;
    if (n == null) return;
    pendingExitHeadingRef.current = null;
    const scroller = () => document.querySelector('[data-loc="explore:preview:scroll"]');
    if (n < 0) {
      scroller()?.scrollTo({ top: 0 });
      return;
    }
    let tries = 0;
    const tick = () => {
      const sc = scroller();
      const heads = sc?.querySelectorAll(
        '.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6',
      );
      if (sc && heads && heads.length > n) {
        const delta = heads[n].getBoundingClientRect().top - sc.getBoundingClientRect().top;
        sc.scrollTop += delta;
        return;
      }
      if (tries++ < 15) requestAnimationFrame(tick); // 等 preview 重新渲染出標題
    };
    requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const cancelEdit = () => {
    rememberExitHeading();
    setEditing(false);
    setSaveErr(null);
    if (sel?.isNew) setSel(null); // 取消新檔 → 清掉
  };

  const save = async () => {
    if (!sel) return;
    rememberExitHeading(); // 退編輯前(編輯器仍在)記住頂端位置
    setSaving(true);
    setSaveErr(null);
    try {
      // 讀 draftRef(同步最新)而非 draft state:GUI 編輯器(如表格)可能剛在
      // 失焦時才寫回 draft,draft state 尚未 re-render;draftRef 一律最新。
      const latest = draftRef.current;
      await api.writeFile(repo, sel.path, latest);
      const wasNew = sel.isNew;
      setSel({ ...sel, content: latest, isNew: false });
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
          setSel({ ...sel, content: draftRef.current, isNew: false });
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

  // 編輯模式 Ctrl/Cmd+S → 存檔但「不離開編輯」(派 porthole:save-file 給上方 listener)。
  // CM6 不攔 Ctrl+S,事件冒泡到 window;preventDefault 擋瀏覽器「儲存網頁」對話框。
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.dispatchEvent(new Event('porthole:save-file'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  // Ctrl/Cmd+H → 開內容搜尋(樹面板內切換)。擋掉瀏覽器預設(Chrome 的歷史紀錄)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setSearchMode(true);
        setTreeMin(false); // 若樹最小化 → 先還原,才看得到搜尋面板
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 重新整理:重載樹 + 重抓目前開啟檔內容(看 agent 改後結果)。編輯模式也重載,
  // 但有「未儲存編輯」時略過以免蓋掉(先存或取消)。圖片以 reloadSeq cache-bust。
  const refresh = () => {
    reloadTree();
    if (!sel) return;
    if (editing && draftRef.current !== sel.content) {
      setNote('內容已可能被外部改動,但有未儲存編輯 → 未重載(請先儲存或取消編輯)');
      return;
    }
    if (sel.image) {
      setReloadSeq((n) => n + 1); // 圖片:換 src cache-bust 重抓
      return;
    }
    const path = sel.path;
    api
      .file(repo, path)
      .then((f) => {
        setSel({ path, content: f.content, markdown: f.markdown, excalidraw: isExcalidraw(path), env: isEnv(path) });
        setCurrentFile({ path, content: f.content });
        if (editing) setDraftSync(f.content); // 同步編輯草稿
        setReloadSeq((n) => n + 1); // 換 key 讓 CM6 編輯器以新內容 remount
      })
      .catch((e: Error) => setErr(e.message));
  };

  // 直接把內容寫進目前開啟檔(Excalidraw 等非文字編輯器存檔用,不走 draft)。
  const saveFileContent = useCallback(
    async (content: string) => {
      const cur = sel;
      if (!cur) return;
      setSaving(true);
      setSaveErr(null);
      try {
        await api.writeFile(repo, cur.path, content);
        setSel({ ...cur, content, isNew: false });
        setCurrentFile({ path: cur.path, content });
        setNote(`已儲存 ${cur.path}`);
        if (cur.isNew) reloadTree(); // 新檔(如新建 .excalidraw)首存 → 讓它出現在樹

      } catch (e) {
        setSaveErr((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [sel, repo],
  );

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
    setSel({ path: p, content: '', markdown: isMd(p), isNew: true, excalidraw: isExcalidraw(p), env: isEnv(p) });
    setSelPath(p);
    noteOpenTab(p, 'new'); // 新檔也成一個分頁
    if (isExcalidraw(p)) {
      setEditing(false); // .excalidraw:直接開白板編輯器(preview 分支),非文字編輯;首存於 saveFileContent 補進樹
    } else {
      setDraftSync('');
      setEditing(true);
    }
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

  // 移動到資料夾:選目標夾 → rename 到「目標夾/原檔名」(後端同一端點,雙路徑 path-guard、
  // 目標已存在回 409)。開啟檔/其祖先夾若被移動則同步改路徑;移動後展開新位置並反白。
  const beginMove = async (p: string) => {
    setMoveTarget(p);
    moveTargetRef.current = p;
    setMoveDest(''); // 強制重新選,避免誤按
    setMoveTree([]);
    setMoveOpen(true);
    setErr(null);
    try {
      const r = await api.tree(repo, '.');
      const dirs = r.items.filter((i) => i.type === 'dir').map((i) => dirToTreeNode(i, p));
      setMoveTree([
        { title: `${repo}/(根目錄)`, value: ROOT_DIR, key: ROOT_DIR, isLeaf: false, selectable: true, children: dirs },
      ]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const onMoveLoadData = async (node: { value?: React.Key }) => {
    const v = node.value == null ? '' : String(node.value);
    const rel = v === ROOT_DIR ? '.' : v;
    try {
      const r = await api.tree(repo, rel);
      const children = r.items.filter((i) => i.type === 'dir').map((i) => dirToTreeNode(i, moveTargetRef.current));
      setMoveTree((prev) => updateDirChildren(prev, v, children));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const moveDestDir = moveDest === ROOT_DIR ? '' : moveDest;
  const moveTo = moveDest && moveTarget ? joinPath(moveDestDir, basename(moveTarget)) : '';
  const commitMove = async () => {
    const from = moveTarget;
    if (!from || !moveDest) return;
    const to = moveTo;
    setMoveOpen(false);
    if (to === from) {
      setNote('已在該資料夾,未移動');
      return;
    }
    setErr(null);
    setNote(null);
    try {
      await api.renamePath(repo, from, to);
      // 開啟檔本身、或其祖先資料夾被移動 → 路徑前綴替換。
      const remap = (path: string): string | null =>
        path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
      if (sel) {
        const np = remap(sel.path);
        if (np) {
          setSel({ ...sel, path: np });
          setSelPath(np);
          setCurrentFile({ path: np, content: sel.content });
        }
      }
      if (selPath) {
        const np = remap(selPath);
        if (np) setSelPath(np);
      }
      await reloadTree();
      await revealAncestors(to); // 展開新位置祖先夾,讓移動後的節點可見
      setSelectedKeys([to]);
      setNote(`已移動 → ${to}`);
    } catch (e) {
      setErr((e as Error).message); // 目標已存在(409)等
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

  // 編輯 markdown 時貼上剪貼簿圖片 → 存到「目前檔所在目錄」(pasted-<時間戳>.<ext>,base64,
  // path-guard),回傳相對檔名供編輯器插入 ![](name)(同目錄故相對路徑 = 檔名)。
  const pasteEditorImage = useCallback(
    async (file: File): Promise<string | null> => {
      const cur = selPath;
      if (!cur) return null;
      const dir = parentDir(cur);
      const name = `pasted-${pasteStamp()}.${imageExt(file.type)}`;
      const b64 = await fileToBase64(file);
      await api.writeFile(repo, joinPath(dir, name), b64, 'base64');
      reloadTree(); // 讓新圖出現在樹 / 之後預覽可讀
      return name;
    },
    [repo, selPath],
  );

  // 選中資料夾時貼上剪貼簿圖片 → 自動命名 pasted-<時間戳> 存進該夾(base64,path-guard),再刷新視圖。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const fv = folderViewRef.current;
      if (!fv) return; // 僅「檢視某資料夾」時接手(選檔/編輯中不攔)
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgs = Array.from(items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f != null);
      if (imgs.length === 0) return; // 非圖片(純文字等)→ 放行,不干擾
      e.preventDefault();
      const dir = fv.path;
      void (async () => {
        setErr(null);
        setNote(null);
        try {
          const stamp = pasteStamp();
          for (let i = 0; i < imgs.length; i++) {
            const f = imgs[i];
            const name = `pasted-${stamp}${imgs.length > 1 ? `-${i + 1}` : ''}.${imageExt(f.type)}`;
            const b64 = await fileToBase64(f);
            await api.writeFile(repo, joinPath(dir, name), b64, 'base64');
          }
          await loadFolderView(dir); // 刷新資料夾視圖 → 新圖出現在清單
          setNote(`已貼上 ${imgs.length} 張圖到 ${dir || repo}(可用 rename 改名)`);
        } catch (err) {
          setErr((err as Error).message);
        }
      })();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [repo, loadFolderView]);

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
    folderMode,
    setFolderMode,
    reloadSeq,
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
    downloadFile: (p: string) => triggerDownload(repo, p),
    moveOpen,
    setMoveOpen,
    moveTarget,
    moveDest,
    setMoveDest,
    moveTree,
    moveTo,
    beginMove: (p: string) => void beginMove(p),
    commitMove: () => void commitMove(),
    onMoveLoadData,
    treeMin,
    setTreeMin,
    openTabs,
    activateTab: (p: string) => activateTab(p),
    closeTab: (p: string) => closeTab(p),
    searchMode,
    setSearchMode,
    searchQ,
    setSearchQ,
    searchRegex,
    setSearchRegex,
    searchCase,
    setSearchCase,
    searchResults,
    searchLoading,
    searchErr,
    searchTruncated,
    searchRan,
    runSearch: () => void runSearch(),
    openHit: (p: string, line: number) => void openHit(p, line),
    onLoadData,
    onSelect,
    refresh,
    saveFileContent: (content: string) => saveFileContent(content),
    editInitialLine: editInitialLineRef.current,
    editorRef,
    pasteEditorImage: (file: File) => pasteEditorImage(file),
    startEdit,
    cancelEdit,
    save: () => void save(),
    createNew,
    createDir: () => void createDir(),
    uploadFiles: (files: FileList) => void uploadFiles(files),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 一行命中:行號 + 片段(命中 substring 標黃底)。 */
function HitLine({ text, col, len }: { text: string; col: number; len: number }) {
  const before = text.slice(0, col);
  const hit = text.slice(col, col + len);
  const after = text.slice(col + len);
  return (
    <span style={{ whiteSpace: 'pre', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
      {before}
      <mark style={{ background: '#fff1a8', padding: 0 }}>{hit}</mark>
      {after}
    </span>
  );
}

/** 內容搜尋面板(Eclipse Ctrl+H 式):搜尋框 + Aa/正則切換 + 結果依檔分組,點命中開檔跳行。 */
function SearchPanel() {
  const c = useExplore();
  const totalHits = c.searchResults.reduce((n, f) => n + f.matches.length, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-loc="explore:search">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <Button
          size="small"
          icon={<LeftOutlined />}
          onClick={() => c.setSearchMode(false)}
          title="返回檔案樹"
          data-loc="explore:search:back"
        />
        <Input
          autoFocus
          size="small"
          placeholder="搜尋檔案內容…"
          value={c.searchQ}
          onChange={(e) => c.setSearchQ(e.target.value)}
          onPressEnter={c.runSearch}
          allowClear
          data-loc="explore:search:input"
          suffix={
            <Space size={2}>
              <Button
                size="small"
                type={c.searchCase ? 'primary' : 'text'}
                onClick={() => c.setSearchCase(!c.searchCase)}
                title="區分大小寫"
                style={{ fontSize: 11, height: 20, padding: '0 4px' }}
                data-loc="explore:search:case"
              >
                Aa
              </Button>
              <Button
                size="small"
                type={c.searchRegex ? 'primary' : 'text'}
                onClick={() => c.setSearchRegex(!c.searchRegex)}
                title="正則表達式"
                style={{ fontSize: 11, height: 20, padding: '0 4px' }}
                data-loc="explore:search:regex"
              >
                .*
              </Button>
            </Space>
          }
        />
        <Button size="small" type="primary" icon={<SearchOutlined />} onClick={c.runSearch} data-loc="explore:search:run" />
      </div>
      {c.searchErr && <Alert type="error" message={c.searchErr} style={{ marginBottom: 6 }} />}
      {c.searchRan && !c.searchErr && (
        <Typography.Text type="secondary" style={{ fontSize: 11, marginBottom: 6 }}>
          {c.searchResults.length} 個檔案 / {totalHits} 處命中{c.searchTruncated ? '(已達上限,結果截斷)' : ''}
        </Typography.Text>
      )}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, margin: '0 -8px', padding: '0 8px' }} data-loc="explore:search:results">
        {c.searchLoading ? (
          <Spin />
        ) : c.searchRan && c.searchResults.length === 0 && !c.searchErr ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            無符合結果
          </Typography.Text>
        ) : (
          c.searchResults.map((f) => (
            <div key={f.path} style={{ marginBottom: 6 }} data-loc="explore:search:file">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '2px 0',
                  color: '#333',
                }}
                title={f.path}
              >
                <FileOutlined style={{ color: '#888', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                <span style={{ color: '#aaa', flexShrink: 0 }}>({f.matches.length})</span>
              </div>
              {f.matches.map((m, i) => (
                <div
                  key={i}
                  onClick={() => c.openHit(f.path, m.line)}
                  className="ph-search-hit"
                  data-loc="explore:search:hit"
                  data-path={f.path}
                  data-line={m.line}
                >
                  <span style={{ color: '#aaa', minWidth: 34, textAlign: 'right', flexShrink: 0, fontSize: 11 }}>
                    {m.line}
                  </span>
                  <HitLine text={m.text} col={m.col} len={m.len} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 檔案樹面板(新檔 / 最小化鈕 + Tree)。 */
function TreePanel() {
  const c = useExplore();
  const fileRef = useRef<HTMLInputElement>(null);
  if (c.searchMode) return <SearchPanel />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
          <Button
            icon={<SearchOutlined />}
            onClick={() => c.setSearchMode(true)}
            title="搜尋檔案內容(Ctrl+H)"
            data-loc="explore:search:open"
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
      {/* 只有 Tree 區捲動;工具列 + 位置列固定置頂(捲動不消失)。 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, margin: '0 -8px', padding: '0 8px' }} data-loc="explore:tree:scroll">
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
                  {n.isLeaf && (
                    <DownloadOutlined
                      title="下載"
                      onClick={(e) => {
                        e.stopPropagation();
                        c.downloadFile(n.path);
                      }}
                    />
                  )}
                  <EditOutlined
                    title="改名"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.beginRename(n.path);
                    }}
                  />
                  <DragOutlined
                    title="移動到資料夾"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.beginMove(n.path);
                    }}
                    data-loc="explore:move:start"
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
      </div>
    </div>
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
        styles={{ body: { padding: 8, display: 'flex', flexDirection: 'column' } }}
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
      style={{
        width: 300,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: '1px solid #f0f0f0',
        padding: 8,
      }}
      data-loc="explore:tree"
    >
      <TreePanel />
    </div>
  );
}

/** VSCode 式分頁列:開啟的檔案為分頁,點切換、× 關閉;active = selPath。 */
function TabStrip() {
  const c = useExplore();
  if (c.openTabs.length === 0) {
    return (
      <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
        選一個項目
      </Typography.Text>
    );
  }
  const isNewPath = c.sel?.isNew ? c.sel.path : null;
  return (
    <div
      style={{ flex: 1, minWidth: 0, display: 'flex', gap: 4, overflowX: 'auto', alignItems: 'center' }}
      data-loc="explore:tabs"
    >
      {c.openTabs.map((p) => {
        const active = p === c.selPath;
        const name = p.split('/').pop() || p;
        return (
          <div
            key={p}
            className={`ph-tab${active ? ' ph-tab-active' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                // 中鍵 → 關閉分頁
                e.preventDefault();
                c.closeTab(p);
              }
            }}
            onClick={() => c.activateTab(p)}
            title={p}
            data-loc="explore:tab"
            data-path={p}
            data-active={active ? '1' : undefined}
          >
            <span className="ph-tab-name">
              {name}
              {p === isNewPath ? ' •' : ''}
            </span>
            <CloseOutlined
              className="ph-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                c.closeTab(p);
              }}
              data-loc="explore:tab:close"
            />
          </div>
        );
      })}
    </div>
  );
}

/** 預覽 / 編輯(中央主區)。 */
export function ExplorePreview() {
  const c = useExplore();
  const newFileOpts = extOptions(c.newPath); // 新增檔:副檔名 smart hint
  // 目錄跳轉:序號對應 preview 裡第 N 個 heading 元素(順序與 parseHeadings 一致)。
  const jumpHeading = (i: number) => {
    const root = document.querySelector('[data-loc="explore:preview"] .md-preview');
    const el = root?.querySelectorAll('h1,h2,h3,h4,h5,h6')[i];
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
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
          <TabStrip />
          {c.sel?.markdown && !c.editing && (
            <Outline text={c.sel.content} onJump={jumpHeading} />
          )}
          {c.sel && !c.sel.isNew && !c.editing && (
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                if (c.sel) c.downloadFile(c.sel.path);
              }}
              title="下載此檔"
              data-loc="explore:download"
            >
              下載
            </Button>
          )}
          {c.sel &&
            !c.sel.image &&
            !c.sel.excalidraw &&
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
          overflow: (c.editing && c.sel?.markdown) || c.sel?.excalidraw ? 'hidden' : 'auto',
          padding: (c.editing && c.sel?.markdown) || c.sel?.excalidraw ? 0 : 16,
        }}
        data-loc="explore:preview:scroll"
      >
        {c.editing && c.sel ? (
          c.sel.markdown ? (
            <Suspense fallback={<Spin />}>
              <MarkdownEditor
                ref={c.editorRef}
                key={`${c.sel.path}:${c.reloadSeq}`}
                value={c.draft}
                onChange={c.setDraft}
                initialLine={c.editInitialLine}
                onImagePaste={c.pasteEditorImage}
              />
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
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}
              data-loc="explore:folder:toolbar"
            >
              <Typography.Text type="secondary" style={{ flex: 1, minWidth: 0 }}>
                {c.folderView.entries.length} 個項目 · 可貼上圖片存入此夾
              </Typography.Text>
              <Segmented
                size="small"
                value={c.folderMode}
                onChange={(v) => c.setFolderMode(v as FolderMode)}
                options={[
                  { value: 'grid', icon: <AppstoreOutlined />, title: 'Grid' },
                  { value: 'list', icon: <BarsOutlined />, title: 'List' },
                ]}
              />
            </div>
            {c.folderView.entries.length === 0 ? (
              <Empty description="空資料夾" />
            ) : c.folderMode === 'list' ? (
              <FolderTable entries={c.folderView.entries} onOpen={c.openPath} />
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
        ) : c.sel.excalidraw ? (
          <Suspense fallback={<Spin />}>
            <ExcalidrawEditor
              key={`${c.sel.path}:${c.reloadSeq}`}
              code={c.sel.content}
              onSave={(json) => void c.saveFileContent(json)}
              fill
            />
          </Suspense>
        ) : c.sel.image ? (
          <img
            src={`${api.rawUrl(c.repo, c.sel.path)}&v=${c.reloadSeq}`}
            alt={c.sel.path}
            style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
            data-loc="explore:image"
          />
        ) : c.sel.env ? (
          <EnvView content={c.sel.content} />
        ) : c.sel.markdown ? (
          <div className="md-preview">
            <Markdown headingAnchors>{c.sel.content}</Markdown>
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
        <AutoComplete
          value={c.newPath}
          options={newFileOpts}
          filterOption={false}
          onChange={(v) => c.setNewPath(v)}
          onKeyDown={(e) => {
            // 有提示時 Enter 交給 AutoComplete 補全;沒提示才直接建立。
            if (e.key === 'Enter' && newFileOpts.length === 0) c.createNew();
          }}
          style={{ width: '100%' }}
          placeholder="例如 idea.md(打 . 看副檔名提示)"
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

      <Modal
        title="移動到資料夾"
        open={c.moveOpen}
        onOk={c.commitMove}
        onCancel={() => c.setMoveOpen(false)}
        okText="移動"
        cancelText="取消"
        okButtonProps={{ disabled: !c.moveDest || c.moveTo === c.moveTarget }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          將 <Typography.Text code>{c.moveTarget}</Typography.Text> 移動到:
        </Typography.Paragraph>
        <TreeSelect
          key={c.moveTarget}
          style={{ width: '100%' }}
          value={c.moveDest || undefined}
          treeData={c.moveTree}
          loadData={c.onMoveLoadData}
          onChange={(v) => c.setMoveDest((v as string) ?? '')}
          placeholder="選目標資料夾"
          showSearch
          treeNodeFilterProp="title"
          treeDefaultExpandedKeys={[ROOT_DIR]}
          popupMatchSelectWidth={false}
          data-loc="explore:move:select"
        />
        {c.moveTo && (
          <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
            →{' '}
            <Typography.Text code type={c.moveTo === c.moveTarget ? 'warning' : undefined}>
              {c.moveTo}
            </Typography.Text>
            {c.moveTo === c.moveTarget && (
              <Typography.Text type="warning"> (已在該資料夾)</Typography.Text>
            )}
          </Typography.Paragraph>
        )}
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
