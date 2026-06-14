/**
 * App — porthole 殼。
 *  - 桌面(≥md):Obsidian/VSCode 式。Explore(檔案樹 + 預覽/編輯)固定占左+中
 *    工作區、恆亮;右側面板放 Chat / Session / CLI,**保活不卸載**(切走不斷
 *    session WS)。右側面板有視窗控制:
 *      Mode(下拉選 Chat/Session/CLI)· 撐滿(覆蓋中央)· 縮小(正常分割)· 最小化(隱藏,右緣 hover 叫回)。
 *    正常模式中間有拖把可調右側寬。手動佈局(非 Splitter)以確保三態切換時
 *    Explore / 終端都不卸載。
 *  - 手機(<md):單窗格 + 左側四-Tab 切換。
 * active repo = URL path 第一段;tab 進 URL hash。
 */
import { useEffect, useRef, useState } from 'react';
import { Layout, Menu, Select, Typography, Spin, Alert, Grid, Dropdown, Button, Space, Modal } from 'antd';
import {
  FolderOpenOutlined,
  MessageOutlined,
  DesktopOutlined,
  CodeOutlined,
  DownOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  MinusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { SESSION_AGENTS, getSessionAgent, setSessionAgent } from './lib/settings';
import Explore, { ExploreProvider, ExploreTree, ExplorePreview } from './tabs/Explore';
import Chat from './tabs/Chat';
import Session from './tabs/Session';
import Cli from './tabs/Cli';
import { api } from './lib/api';

const { Header, Sider, Content } = Layout;

type TabKey = 'explore' | 'chat' | 'session' | 'cli';
type RightKey = 'chat' | 'session' | 'cli';
type RightMode = 'normal' | 'max' | 'min';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'explore', label: 'Explore', icon: <FolderOpenOutlined /> },
  { key: 'chat', label: 'Chat', icon: <MessageOutlined /> },
  { key: 'session', label: 'Session', icon: <DesktopOutlined /> },
  { key: 'cli', label: 'CLI', icon: <CodeOutlined /> },
];

const TAB_KEYS: TabKey[] = ['explore', 'chat', 'session', 'cli'];
const RIGHT_TABS: { key: RightKey; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'session', label: 'Session' },
  { key: 'cli', label: 'CLI' },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

/** tab 由 URL hash 帶(`/coral#chat`);非法值退回 explore。 */
function tabFromUrl(): TabKey {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  return (TAB_KEYS as string[]).includes(h) ? (h as TabKey) : 'explore';
}

export default function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string>(repoFromUrl());
  const [tab, setTab] = useState<TabKey>(tabFromUrl());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agent, setAgent] = useState<string>(getSessionAgent());
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  // 右側面板:選哪個(tab=explore 時退回 chat)、視窗模式、正常模式寬度、最小化 hover。
  const rightSel: RightKey = tab === 'explore' ? 'chat' : tab;
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

  // 保活:右側已造訪過的 tab 一旦掛載就保留(切走只隱藏,不卸載 → 終端不斷)。
  const [visited, setVisited] = useState<Set<RightKey>>(() => new Set<RightKey>([rightSel]));
  useEffect(() => {
    setVisited((prev) => (prev.has(rightSel) ? prev : new Set(prev).add(rightSel)));
  }, [rightSel]);

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

  // repo → URL pathname(換 repo 進歷史,保留當前 tab hash)
  useEffect(() => {
    if (repo && repoFromUrl() !== repo) {
      history.pushState(null, '', `/${encodeURIComponent(repo)}#${tab}`);
    }
  }, [repo, tab]);

  // repo → Chrome 分頁標題
  useEffect(() => {
    document.title = repo ? `${repo} · porthole` : 'porthole · 舷窗';
  }, [repo]);

  // tab → URL hash(切 tab 只改 hash,不灌歷史)
  useEffect(() => {
    if (location.hash !== `#${tab}`) {
      history.replaceState(null, '', `${location.pathname}#${tab}`);
    }
  }, [tab]);

  // 上一頁/下一頁、手改 hash → 同步回 state
  useEffect(() => {
    const sync = () => {
      const r = repoFromUrl();
      if (r) setRepo(r);
      setTab(tabFromUrl());
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
        background: '#001529',
        padding: isMobile ? '0 12px' : '0 16px',
      }}
      data-loc="app:header"
    >
      <img src="/favicon.svg" width={24} height={24} alt="" data-loc="app:header:logo" />
      <Typography.Text strong style={{ color: '#fff', fontSize: 16 }}>
        porthole
      </Typography.Text>
      {!isMobile && (
        <Typography.Text style={{ color: '#8c8c8c', fontSize: 12 }}>舷窗</Typography.Text>
      )}
      <Select
        value={repo || undefined}
        onChange={setRepo}
        options={repos.map((r) => ({ value: r, label: r }))}
        style={isMobile ? { flex: 1, marginLeft: 8 } : { minWidth: 200, marginLeft: 16 }}
        placeholder="選 repo"
        showSearch
        data-loc="app:repo:select"
      />
      <Button
        type="text"
        icon={<SettingOutlined />}
        onClick={() => setSettingsOpen(true)}
        style={{ color: '#fff', marginLeft: 8 }}
        title="設定"
        data-loc="app:settings"
      />
      {err && <Alert type="error" message={err} banner style={{ marginLeft: 'auto' }} />}
    </Header>
  );

  const settingsModal = (
    <Modal
      title="設定"
      open={settingsOpen}
      onCancel={() => setSettingsOpen(false)}
      footer={null}
      data-loc="app:settings:modal"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>新 session 使用的 agent</span>
        <Select
          value={agent}
          onChange={(v) => {
            setAgent(v);
            setSessionAgent(v);
          }}
          options={SESSION_AGENTS.map((a) => ({ value: a, label: a }))}
          style={{ width: 160 }}
          data-loc="app:settings:agent"
        />
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        套用於 Session tab 的「新 session」。後端僅允許白名單內的 agent。
      </Typography.Paragraph>
    </Modal>
  );

  // 右側控制列:Mode 下拉(選 Chat/Session/CLI)+ 撐滿 / 縮小 / 最小化。
  const modeLabel = RIGHT_TABS.find((t) => t.key === rightSel)?.label ?? 'Chat';
  const controlBar = (
    <Space size={4}>
      <Dropdown
        trigger={['click']}
        getPopupContainer={(t) => t.parentElement ?? document.body}
        menu={{
          items: RIGHT_TABS.map((t) => ({ key: t.key, label: t.label })),
          selectedKeys: [rightSel],
          onClick: ({ key }) => {
            setTab(key as RightKey);
            if (rightMode === 'min') setRightMode('normal'); // 從最小化選 Mode → 順手叫回
          },
        }}
      >
        <Button size="small" data-loc="app:right:mode">
          Mode · {modeLabel} <DownOutlined />
        </Button>
      </Dropdown>
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

  // 右側面板:控制列 + 保活內容(已造訪的都掛著,非 active 用 display:none)
  const rightPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-loc="app:right">
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center' }}>
        {controlBar}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {RIGHT_TABS.map(
          (t) =>
            visited.has(t.key) && (
              <div
                key={t.key}
                style={{ position: 'absolute', inset: 0, display: rightSel === t.key ? 'block' : 'none' }}
                data-loc={`app:right:${t.key}`}
              >
                {t.key === 'chat' && <Chat repo={repo} />}
                {t.key === 'session' && <Session repo={repo} />}
                {t.key === 'cli' && <Cli repo={repo} />}
              </div>
            ),
        )}
      </div>
    </div>
  );

  // 三區佈局隨模式變寬:tree 固定在左恆亮;撐滿=收掉中央 preview、右側補上;
  // 最小化=收掉右側、preview 補上(右緣留 hover 條)。preview/終端都不卸載。
  const previewRegionStyle: React.CSSProperties =
    rightMode === 'max' ? { display: 'none' } : { flex: 1, minWidth: 0 };
  const rightRegionStyle: React.CSSProperties =
    rightMode === 'min'
      ? { display: 'none' }
      : rightMode === 'max'
        ? { flex: 1, minWidth: 0, borderLeft: '1px solid #f0f0f0' }
        : { width: rightWidth, flexShrink: 0, borderLeft: '1px solid #f0f0f0' };

  const desktopBody = !repo ? (
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
            style={{ width: 6, cursor: 'col-resize', background: '#f0f0f0', flexShrink: 0 }}
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
                  background: '#fff',
                  border: '1px solid #f0f0f0',
                  borderRadius: 6,
                  padding: 8,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                }}
              >
                {controlBar}
              </div>
            )}
            <div
              style={{ height: '100%', width: 12, background: '#fafafa', borderLeft: '1px solid #f0f0f0', cursor: 'pointer' }}
            />
          </div>
        )}
      </div>
    </ExploreProvider>
  );

  // 手機單窗格:依 tab 顯示單一區塊。
  const mobileMain = !repo ? (
    <Alert type="info" message="basePath 下沒有可用的 repo" />
  ) : tab === 'explore' ? (
    <Explore repo={repo} />
  ) : tab === 'chat' ? (
    <Chat repo={repo} />
  ) : tab === 'session' ? (
    <Session repo={repo} />
  ) : (
    <Cli repo={repo} />
  );

  return (
    <Layout style={{ height: '100vh' }}>
      {header}
      {settingsModal}
      <Layout>
        {isMobile ? (
          <>
            <Sider
              width={120}
              collapsedWidth={56}
              collapsed
              theme="light"
              style={{ borderRight: '1px solid #f0f0f0' }}
            >
              <Menu
                mode="inline"
                selectedKeys={[tab]}
                onClick={(e) => setTab(e.key as TabKey)}
                items={TABS.map((t) => ({ key: t.key, icon: t.icon, label: t.label }))}
                style={{ height: '100%', borderInlineEnd: 'none' }}
              />
            </Sider>
            <Content style={{ background: '#fff', overflow: 'hidden' }}>{mobileMain}</Content>
          </>
        ) : (
          <Content style={{ background: '#fff', overflow: 'hidden' }}>{desktopBody}</Content>
        )}
      </Layout>
    </Layout>
  );
}
