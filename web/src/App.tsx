/**
 * App — porthole 殼。兩個模式,頂部 header 切換(SPEC §3):
 *
 *  - **檔案**(`#file`,預設):Obsidian/VSCode 式三欄。Explore(檔案樹 + 預覽/編輯)固定占
 *    左+中工作區、恆亮;右側是**當前開著那個檔的對話**(綁檔對話,SPEC §4.2.1)。
 *    右側有視窗控制:撐滿(覆蓋中央)· 縮小(正常分割)· 最小化(隱藏,右緣 hover 叫回)。
 *    正常模式中間有拖把可調右側寬。手動佈局(非 Splitter)以確保三態切換時 Explore 不卸載。
 *  - **對話**(`#chat`):全頁對話 —— 左邊列全部對話,右邊是對話本體,不綁任何檔。
 *
 *  active repo = URL path 第一段;模式進 URL hash。Session / CLI 兩個 Tab 已於 2026-10-25
 *  退場(PTY / tmux / WebSocket 全移除),舊的 `#session` / `#cli` 書籤落回 `#file`。
 */
import { useEffect, useRef, useState } from 'react';
import { Layout, Select, Typography, Spin, Alert, Grid, Button, Space, Segmented } from 'antd';
import {
  FolderOpenOutlined,
  MessageOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  MinusOutlined,
} from '@ant-design/icons';
import Explore, { ExploreProvider, ExploreTree, ExplorePreview } from './tabs/Explore';
import Chat from './tabs/Chat';
import { api } from './lib/api';
import { CURRENT_FILE_EVENT, getCurrentFile } from './lib/currentFile';
import { PALETTE } from './theme';

const { Header, Content } = Layout;

type Mode = 'file' | 'chat';
type RightMode = 'normal' | 'max' | 'min';

const MODES: { value: Mode; label: string; icon: React.ReactNode }[] = [
  { value: 'file', label: '檔案', icon: <FolderOpenOutlined /> },
  { value: 'chat', label: '對話', icon: <MessageOutlined /> },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

/**
 * 模式由 URL hash 帶(`/coral#chat`)。
 * `#explore` 是舊名 → file;退場的 `#session` / `#cli` 也落回 file(舊書籤不要變白畫面)。
 */
function modeFromUrl(): Mode {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  return h === 'chat' ? 'chat' : 'file';
}

export default function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string>(repoFromUrl());
  const [mode, setMode] = useState<Mode>(modeFromUrl());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  // 檔案模式:現在開著哪個檔 → 右側對話切到那個檔的綁檔對話。
  const [openFile, setOpenFile] = useState<string | null>(() => getCurrentFile()?.path ?? null);
  useEffect(() => {
    const onFile = (e: Event) => {
      setOpenFile(((e as CustomEvent).detail as { path: string | null }).path);
    };
    window.addEventListener(CURRENT_FILE_EVENT, onFile);
    return () => window.removeEventListener(CURRENT_FILE_EVENT, onFile);
  }, []);
  useEffect(() => {
    setOpenFile(null); // 換 repo → 路徑空間不同,先清掉
  }, [repo]);

  // 右側面板:視窗模式、正常模式寬度、最小化 hover。
  const [rightMode, setRightMode] = useState<RightMode>('normal');
  const [rightWidth, setRightWidth] = useState(480);
  const [minHover, setMinHover] = useState(false);
  const workRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const minHoverTimer = useRef<number | undefined>(undefined);
  const openMin = () => {
    if (minHoverTimer.current) clearTimeout(minHoverTimer.current);
    setMinHover(true);
  };
  const closeMin = () => {
    minHoverTimer.current = window.setTimeout(() => setMinHover(false), 200);
  };

  // 正常模式:拖中間把手調右側寬。
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !workRef.current) return;
      const rect = workRef.current.getBoundingClientRect();
      setRightWidth(clamp(rect.right - e.clientX, 320, rect.width - 320));
    };
    const up = () => {
      dragging.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  useEffect(() => {
    api
      .repos()
      .then((r) => {
        setRepos(r.repos);
        setRepo((cur) => (cur && r.repos.includes(cur) ? cur : (r.repos[0] ?? '')));
        setLoading(false);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setLoading(false);
      });
  }, []);

  // repo → URL pathname(換 repo 進歷史,保留當前模式 hash)
  useEffect(() => {
    if (repo && repoFromUrl() !== repo) {
      history.pushState(null, '', `/${encodeURIComponent(repo)}#${mode}`);
    }
  }, [repo, mode]);

  // repo → Chrome 分頁標題
  useEffect(() => {
    document.title = repo ? `${repo} · porthole` : 'porthole · 舷窗';
  }, [repo]);

  // 連結導航(MarkdownEditor / Chat 的綁檔 chip 派 porthole:navigate):切 repo / 模式;
  // 開檔由 Explore 接手。
  useEffect(() => {
    const onNav = (e: Event) => {
      const d = (e as CustomEvent).detail as { repo?: string; tab?: string };
      if (d.repo && d.repo !== repo) setRepo(d.repo);
      if (d.tab === 'chat') setMode('chat');
      else if (d.tab) setMode('file'); // 舊的 explore / session / cli 都落回檔案模式
    };
    window.addEventListener('porthole:navigate', onNav);
    return () => window.removeEventListener('porthole:navigate', onNav);
  }, [repo]);

  // 模式 → URL hash(切模式只改 hash,不灌歷史)。保留 location.search
  // (`?sec=` 章節 deep-link、`?thread=` 對話),否則切模式會把它們從網址抹掉。
  useEffect(() => {
    if (location.hash !== `#${mode}`) {
      history.replaceState(null, '', `${location.pathname}${location.search}#${mode}`);
    }
  }, [mode]);

  // 上一頁/下一頁、手改 hash → 同步回 state(檔案由 Explore 的 popstate 接手開)
  useEffect(() => {
    const sync = () => {
      const r = repoFromUrl();
      if (r) setRepo(r);
      setMode(modeFromUrl());
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  if (loading) return <Spin style={{ margin: 40 }} />;

  const header = (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: PALETTE.surface,
        borderBottom: `1px solid ${PALETTE.line}`,
        padding: isMobile ? '0 12px' : '0 16px',
      }}
      data-loc="app:header"
    >
      <img src="/favicon.svg" width={22} height={22} alt="" data-loc="app:header:logo" />
      <Typography.Text strong style={{ color: PALETTE.accent, fontSize: 16 }}>
        porthole
      </Typography.Text>
      {!isMobile && (
        <Typography.Text style={{ color: PALETTE.muted, fontSize: 12 }}>舷窗</Typography.Text>
      )}
      <Select
        value={repo || undefined}
        onChange={setRepo}
        options={repos.map((r) => ({ value: r, label: r }))}
        style={isMobile ? { flex: 1, marginLeft: 4 } : { minWidth: 180, marginLeft: 12 }}
        placeholder="選 repo"
        showSearch
        data-loc="app:repo:select"
      />
      {/* 檔案 / 對話 —— 整個 app 只有這兩個模式(SPEC §3) */}
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={MODES.map((m) => ({
          value: m.value,
          label: isMobile ? undefined : m.label,
          icon: m.icon,
        }))}
        style={{ marginLeft: 'auto' }}
        data-loc="app:header:mode"
      />
      {err && <Alert type="error" message={err} banner style={{ marginLeft: 12 }} />}
    </Header>
  );

  // 右側控制列:撐滿 / 縮小 / 最小化(只剩對話一種內容,故不再有 Mode 下拉)。
  const controlBar = (
    <Space size={4}>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
        對話
      </Typography.Text>
      <Button
        size="small"
        icon={<FullscreenOutlined />}
        title="撐滿"
        disabled={rightMode === 'max'}
        onClick={() => setRightMode('max')}
        data-loc="app:right:max"
      />
      <Button
        size="small"
        icon={<FullscreenExitOutlined />}
        title="縮小(正常)"
        disabled={rightMode === 'normal'}
        onClick={() => setRightMode('normal')}
        data-loc="app:right:restore"
      />
      <Button
        size="small"
        icon={<MinusOutlined />}
        title="最小化"
        disabled={rightMode === 'min'}
        onClick={() => setRightMode('min')}
        data-loc="app:right:minimize"
      />
    </Space>
  );

  // 右側面板 = 當前檔的對話。**不卸載**(切 max/min 只改寬度,串流與草稿都不斷)。
  const rightPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-loc="app:right">
      <div
        style={{
          padding: 8,
          borderBottom: `1px solid ${PALETTE.line}`,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {controlBar}
      </div>
      <div style={{ flex: 1, minHeight: 0 }} data-loc="app:right:chat">
        <Chat repo={repo} isActive layout="panel" linkPath={openFile} />
      </div>
    </div>
  );

  // 三區佈局隨模式變寬:tree 固定在左恆亮;撐滿=收掉中央 preview、右側補上;
  // 最小化=收掉右側、preview 補上(右緣留 hover 條)。preview 不卸載。
  const previewRegionStyle: React.CSSProperties =
    rightMode === 'max' ? { display: 'none' } : { flex: 1, minWidth: 0 };
  const rightRegionStyle: React.CSSProperties =
    rightMode === 'min'
      ? { display: 'none' }
      : rightMode === 'max'
        ? { flex: 1, minWidth: 0, borderLeft: `1px solid ${PALETTE.line}` }
        : { width: rightWidth, flexShrink: 0, borderLeft: `1px solid ${PALETTE.line}` };

  const fileBody = !repo ? (
    <Alert type="info" message="basePath 下沒有可用的 repo" style={{ margin: 16 }} />
  ) : (
    <ExploreProvider repo={repo}>
      <div
        ref={workRef}
        style={{ display: 'flex', height: '100%', position: 'relative' }}
        data-loc="app:work"
      >
        <ExploreTree />
        <div style={previewRegionStyle} data-loc="app:center">
          <ExplorePreview />
        </div>

        {rightMode === 'normal' && (
          <div
            onMouseDown={(e) => {
              dragging.current = true;
              document.body.style.userSelect = 'none';
              e.preventDefault();
            }}
            style={{ width: 6, cursor: 'col-resize', background: PALETTE.line, flexShrink: 0 }}
            data-loc="app:right:drag"
          />
        )}

        <div style={rightRegionStyle}>{rightPanel}</div>

        {/* 最小化:右緣 hover 條 → 叫回控制列。選單與條當相鄰 flex 子元素(無死區),
            移到選單仍在容器內 → 不會誤觸 mouseleave 而消失。 */}
        {rightMode === 'min' && (
          <div
            onMouseEnter={openMin}
            onMouseLeave={closeMin}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              height: '100%',
              zIndex: 20,
              display: 'flex',
              alignItems: 'flex-start',
            }}
            data-loc="app:right:minbar"
          >
            {minHover && (
              <div
                style={{
                  marginTop: 8,
                  background: PALETTE.card,
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: 8,
                  padding: 8,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
                }}
              >
                {controlBar}
              </div>
            )}
            <div
              style={{
                height: '100%',
                width: 12,
                background: PALETTE.surface,
                borderLeft: `1px solid ${PALETTE.line}`,
                cursor: 'pointer',
              }}
            />
          </div>
        )}
      </div>
    </ExploreProvider>
  );

  // 對話模式:全頁對話(自帶左側列表),不綁檔。
  const chatBody = !repo ? (
    <Alert type="info" message="basePath 下沒有可用的 repo" style={{ margin: 16 }} />
  ) : (
    <Chat repo={repo} isActive layout={isMobile ? 'panel' : 'full'} />
  );

  // 手機單窗格:檔案模式顯示 Explore(對話靠切模式看),對話模式顯示對話。
  const mobileBody = !repo ? (
    <Alert type="info" message="basePath 下沒有可用的 repo" />
  ) : mode === 'file' ? (
    <Explore repo={repo} />
  ) : (
    chatBody
  );

  return (
    <Layout style={{ height: '100vh' }}>
      {header}
      <Layout>
        <Content style={{ background: PALETTE.bg, overflow: 'hidden' }}>
          {isMobile ? mobileBody : mode === 'file' ? fileBody : chatBody}
        </Content>
      </Layout>
    </Layout>
  );
}
