/**
 * Session tab — 列 claude -r 可恢復 session;點一個 → 對應 tmux 背景跑 → xterm attach。
 *  - 左:claude session 列表(讀 ~/.claude/projects;deterministic-first)
 *  - 右:attach 進對應 tmux session(detach = 切走/關 WS,背景續跑)
 */
import { useEffect, useState } from 'react';
import { List, Button, Typography, Alert, Space, Tag, Popconfirm } from 'antd';
import Terminal from '../lib/Terminal';
import { api, type ClaudeSession } from '../lib/api';

interface Props {
  repo: string;
}

export default function Session({ repo }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [tmuxNames, setTmuxNames] = useState<string[]>([]);
  const [attached, setAttached] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

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
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  const startNew = async () => {
    setStarting('__new__');
    setErr(null);
    try {
      const { name } = await api.newSession(repo);
      setAttached(name);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(null);
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

  // 屬於本 repo、但還沒對應到 jsonl 的背景 tmux(新開、尚未互動的 claude)。
  const safeRepo = repo.replace(/[^A-Za-z0-9_]/g, '_');
  const sessionTnames = new Set(
    sessions.map(
      (s) => `porthole_${safeRepo}_${s.id.replace(/[^A-Za-z0-9_]/g, '').slice(0, 8)}`,
    ),
  );
  const extraTmux = tmuxNames.filter(
    (n) => n.startsWith(`porthole_${safeRepo}_`) && !sessionTnames.has(n),
  );

  return (
    <div style={{ display: 'flex', height: '100%' }} data-loc="session:root">
      <div
        style={{ width: 340, borderRight: '1px solid #f0f0f0', padding: 8, overflow: 'auto' }}
        data-loc="session:list"
      >
        <Button
          block
          type="primary"
          loading={starting === '__new__'}
          onClick={() => void startNew()}
          style={{ marginBottom: 8 }}
          data-loc="session:new"
        >
          + 新 session
        </Button>
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" onClick={refresh}>
            重新整理
          </Button>
          {tmuxNames.length > 0 && <Tag color="green">{tmuxNames.length} 個背景 tmux</Tag>}
        </Space>
        {err && <Alert type="error" message={err} style={{ marginBottom: 8 }} />}
        {extraTmux.length > 0 && (
          <List
            size="small"
            header={<Typography.Text type="secondary">$ 系統開的 tmux(裸 shell)</Typography.Text>}
            dataSource={extraTmux}
            style={{ marginBottom: 8 }}
            renderItem={(name) => (
              <List.Item style={{ display: 'block' }} data-loc="session:live">
                <Typography.Text ellipsis style={{ maxWidth: 300 }} title={name}>
                  ${name.replace(`porthole_${safeRepo}_`, '')}
                </Typography.Text>
                <div style={{ marginTop: 6 }}>
                  <Space>
                    <Button size="small" type="primary" onClick={() => setAttached(name)}>
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

      <div style={{ flex: 1, background: '#1e1e1e', padding: 8 }} data-loc="session:term">
        {attached ? (
          <Terminal path={`/ws/tmux/${attached}`} sessionKey={attached} />
        ) : (
          <div style={{ color: '#888', padding: 16, fontFamily: 'monospace' }}>
            選一個 session「開背景並 attach」。detach 只要切走或關閉,tmux 會在背景續跑。
          </div>
        )}
      </div>
    </div>
  );
}
