/**
 * Session tab — 列 claude -r 可恢復 session;點一個 → 對應 tmux 背景跑 → xterm attach。
 *  - 左:claude session 列表(讀 ~/.claude/projects;deterministic-first)
 *  - 右:attach 進對應 tmux session(detach = 切走/關 WS,背景續跑)
 */
import { useEffect, useState } from 'react';
import { List, Button, Typography, Alert, Space, Tag, Popconfirm, Popover } from 'antd';
import { UnorderedListOutlined, DesktopOutlined } from '@ant-design/icons';
import Terminal from '../lib/Terminal';
import { api, type ClaudeSession } from '../lib/api';
import { getSessionAgent } from '../lib/settings';

interface Props {
  repo: string;
}

export default function Session({ repo }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [tmuxNames, setTmuxNames] = useState<string[]>([]);
  const [attached, setAttached] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false); // 頂部 List 選單(session 列表)

  const refresh = () => {
    api
      .sessions(repo)
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => setErr(e.message));
    api.tmuxList().then((r) => setTmuxNames(r.sessions)).catch(() => undefined);
  };

  useEffect(() => {
    setSessions([]);
    setTmuxNames([]);
    setAttached(null);
    setErr(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const start = async (id: string) => {
    setStarting(id);
    setErr(null);
    try {
      const { name } = await api.startSession(repo, id);
      setAttached(name);
      setListOpen(false); // 接上後關選單,露出終端
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  // 開全新背景 session(裸 tmux 跑 claude)→ 開好直接 attach。
  const newSession = async () => {
    setErr(null);
    try {
      const { name } = await api.newSession(repo, getSessionAgent());
      setAttached(name);
      setListOpen(false);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const kill = async (name: string) => {
    try {
      await api.tmuxKill(name);
      if (attached === name) setAttached(null);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const sessionList = (
    <div style={{ width: 340, maxHeight: 380, overflow: 'auto' }} data-loc="session:list">
      {err && <Alert type="error" message={err} style={{ marginBottom: 8 }} />}
      {tmuxNames.length > 0 && (
        <div style={{ marginBottom: 8 }} data-loc="session:tmux">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            背景 tmux session
          </Typography.Text>
          <List
            size="small"
            dataSource={tmuxNames}
            renderItem={(name) => (
              <List.Item style={{ display: 'block' }}>
                <Typography.Text ellipsis style={{ fontSize: 12, display: 'block' }} title={name}>
                  {name}
                </Typography.Text>
                <div style={{ marginTop: 4 }}>
                  <Space>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => {
                        setAttached(name);
                        setListOpen(false);
                      }}
                    >
                      attach
                    </Button>
                    <Popconfirm title="收掉這個 tmux session?" onConfirm={() => void kill(name)}>
                      <Button size="small" danger>
                        收掉
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              </List.Item>
            )}
          />
          <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0 4px' }} />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            可恢復 claude session
          </Typography.Text>
        </div>
      )}
      <List
        size="small"
        dataSource={sessions}
        locale={{ emptyText: '此 repo 無可恢復 session' }}
        renderItem={(s) => {
          const tname = `porthole_${repo.replace(/[^A-Za-z0-9_]/g, '_')}_${s.id
            .replace(/[^A-Za-z0-9_]/g, '')
            .slice(0, 8)}`;
          const live = tmuxNames.includes(tname);
          return (
            <List.Item style={{ display: 'block' }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text ellipsis style={{ maxWidth: 300 }} title={s.title}>
                  {s.title}
                </Typography.Text>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {s.id.slice(0, 8)} · {new Date(s.mtime).toLocaleString()}
              </Typography.Text>
              <div style={{ marginTop: 6 }}>
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    loading={starting === s.id}
                    onClick={() => void start(s.id)}
                  >
                    {live ? 'attach' : '開背景並 attach'}
                  </Button>
                  {live && (
                    <Popconfirm title="收掉這個 tmux session?" onConfirm={() => void kill(tname)}>
                      <Button size="small" danger>
                        收掉
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              </div>
            </List.Item>
          );
        }}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-loc="session:root">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
        }}
        data-loc="session:topbar"
      >
        <Popover
          trigger="click"
          open={listOpen}
          onOpenChange={setListOpen}
          content={sessionList}
          placement="bottomLeft"
          title={
            <Button size="small" onClick={refresh} data-loc="session:refresh">
              重新整理
            </Button>
          }
        >
          <Button icon={<UnorderedListOutlined />} data-loc="session:list:toggle">
            List
          </Button>
        </Popover>
        <Button
          icon={<DesktopOutlined />}
          onClick={() => void newSession()}
          title="開全新背景 session(claude)並 attach"
          data-loc="session:new"
        >
          新 session
        </Button>
        {tmuxNames.length > 0 && <Tag color="green">{tmuxNames.length} 個背景 tmux</Tag>}
        {attached && (
          <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>
            {attached}
          </Typography.Text>
        )}
      </div>

      <div style={{ flex: 1, background: '#1e1e1e', padding: 8, minHeight: 0 }} data-loc="session:term">
        {attached ? (
          <Terminal path={`/ws/tmux/${attached}`} sessionKey={attached} />
        ) : (
          <div style={{ color: '#888', padding: 16, fontFamily: 'monospace' }}>
            開「List」選一個 session「開背景並 attach」。detach 只要切走或關閉,tmux 會在背景續跑。
          </div>
        )}
      </div>
    </div>
  );
}
