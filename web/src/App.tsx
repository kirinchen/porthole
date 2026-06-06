/**
 * App — porthole 殼。仿 Claude Desktop:頂部 repo 選擇器 + 左側四 Tab + 右側主區。
 * active repo = URL path 第一段(/coral → coral),切換時 pushState。
 */
import { useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Select, Typography, Spin, Alert, Grid } from 'antd';
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

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'explore', label: 'Explore', icon: <FolderOpenOutlined /> },
  { key: 'chat', label: 'Chat', icon: <MessageOutlined /> },
  { key: 'session', label: 'Session', icon: <DesktopOutlined /> },
  { key: 'cli', label: 'CLI', icon: <CodeOutlined /> },
];

function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

export default function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string>(repoFromUrl());
  const [tab, setTab] = useState<TabKey>('explore');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md; // <768px:Sider 收成 icon-only,header 精簡

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

  // repo → URL
  useEffect(() => {
    if (repo && repoFromUrl() !== repo) {
      history.pushState(null, '', `/${encodeURIComponent(repo)}`);
    }
  }, [repo]);

  const main = useMemo(() => {
    if (!repo) return <Alert type="info" message="basePath 下沒有可用的 repo" />;
    switch (tab) {
      case 'explore':
        return <Explore repo={repo} />;
      case 'chat':
        return <Chat repo={repo} />;
      case 'session':
        return <Session repo={repo} />;
      case 'cli':
        return <Cli repo={repo} />;
    }
  }, [tab, repo]);

  if (loading) return <Spin style={{ margin: 40 }} />;

  return (
    <Layout style={{ height: '100vh' }}>
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
      <Layout>
        <Sider
          width={120}
          collapsedWidth={56}
          collapsed={isMobile}
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
        <Content style={{ background: '#fff', overflow: 'hidden' }}>{main}</Content>
      </Layout>
    </Layout>
  );
}
