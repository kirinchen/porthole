/**
 * App — porthole 殼。
 *  - 桌面(≥md):Obsidian/VSCode 式三欄。Explore(檔案樹 + 預覽/編輯)固定占
 *    左+中工作區;右側面板以 tab 切 Chat / Session / CLI,且**保活不卸載**
 *    (切走不斷 session WS)。中央/右側交界用 Splitter 可拖寬窄。
 *  - 手機(<md):三欄塞不下 → 沿用單窗格 + 左側四-Tab 切換。
 * active repo = URL path 第一段(/coral → coral);tab 進 URL hash。
 */
import { useEffect, useState } from 'react';
import { Layout, Menu, Select, Typography, Spin, Alert, Grid, Segmented, Splitter } from 'antd';
import {
  FolderOpenOutlined,
  MessageOutlined,
  DesktopOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import Explore from './tabs/Explore';
import Chat from './tabs/Chat';
import Session from './tabs/Session';
import Cli from './tabs/Cli';
import { api } from './lib/api';

const { Header, Sider, Content } = Layout;

type TabKey = 'explore' | 'chat' | 'session' | 'cli';
type RightKey = 'chat' | 'session' | 'cli';

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
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  // 桌面右側面板選擇:tab 為 explore(桌面左欄恆亮)時退回 chat。
  const rightSel: RightKey = tab === 'explore' ? 'chat' : tab;
  // 保活:右側已造訪過的 tab 一旦掛載就保留(切走只隱藏,不卸載 → 終端不斷)。
  const [visited, setVisited] = useState<Set<RightKey>>(() => new Set<RightKey>([rightSel]));
  useEffect(() => {
    setVisited((prev) => (prev.has(rightSel) ? prev : new Set(prev).add(rightSel)));
  }, [rightSel]);

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
      {err && <Alert type="error" message={err} banner style={{ marginLeft: 'auto' }} />}
    </Header>
  );

  // 右側面板(桌面):tab bar + 保活內容(已造訪的都掛著,非 active 用 display:none)
  const rightPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-loc="app:right">
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Segmented
          block
          value={rightSel}
          onChange={(v) => setTab(v as RightKey)}
          options={RIGHT_TABS.map((t) => ({ label: t.label, value: t.key }))}
          data-loc="app:right:tabs"
        />
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

  // 桌面三欄:Explore(樹+預覽)占左+中;右側面板。中央/右側可拖。
  const desktopBody = !repo ? (
    <Alert type="info" message="basePath 下沒有可用的 repo" style={{ margin: 16 }} />
  ) : (
    <Splitter style={{ height: '100%' }}>
      <Splitter.Panel min="30%">
        <Explore repo={repo} />
      </Splitter.Panel>
      <Splitter.Panel defaultSize="40%" min="22%" max="68%" collapsible>
        {rightPanel}
      </Splitter.Panel>
    </Splitter>
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
