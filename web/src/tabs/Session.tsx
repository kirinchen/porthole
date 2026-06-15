/**
 * Session tab — 列 claude -r 可恢復 session;點一個 → 對應 tmux 背景跑 → xterm attach。
 *  - 左:claude session 列表(讀 ~/.claude/projects;deterministic-first)
 *  - 右:attach 進對應 tmux session(detach = 切走/關 WS,背景續跑)
 */
import { useEffect, useState } from 'react';
import {
  List,
  Button,
  Typography,
  Alert,
  Space,
  Tag,
  Popconfirm,
  Popover,
  Modal,
  AutoComplete,
  Switch,
  Input,
} from 'antd';
import { UnorderedListOutlined, DesktopOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import Terminal from '../lib/Terminal';
import { api, type ClaudeSession } from '../lib/api';
import {
  getSessionAgent,
  setSessionAgent,
  SESSION_AGENTS,
  getAliases,
  setAlias,
} from '../lib/settings';

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
  const [newOpen, setNewOpen] = useState(false); // 新 session / 恢復 session 表單
  const [resumeId, setResumeId] = useState<string | null>(null); // 非 null = 恢復該 claude session
  const [agent, setAgent] = useState<string>(getSessionAgent());
  const [yolo, setYolo] = useState(false);
  const [args, setArgs] = useState('');
  const [aliasMap, setAliasMap] = useState<Record<string, string>>(getAliases());
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasTarget, setAliasTarget] = useState('');
  const [aliasInput, setAliasInput] = useState('');

  const label = (name: string) => aliasMap[name] || name; // 有別名顯示別名

  const openAlias = (name: string) => {
    setAliasTarget(name);
    setAliasInput(aliasMap[name] || '');
    setAliasOpen(true);
  };
  const saveAlias = () => {
    setAlias(aliasTarget, aliasInput);
    setAliasMap(getAliases());
    setAliasOpen(false);
  };

  // 只留本 repo 的背景 tmux(/api/tmux 是全域列舉所有 porthole_*,要依本 repo 前綴過濾)。
  const tmuxPrefix = `porthole_${repo.replace(/[^A-Za-z0-9_]/g, '_')}_`;

  const refresh = () => {
    api
      .sessions(repo)
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => setErr(e.message));
    api
      .tmuxList()
      .then((r) => setTmuxNames(r.sessions.filter((n) => n.startsWith(tmuxPrefix))))
      .catch(() => undefined);
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

  // 依表單送出:resume → claude --resume <id> [參數];否則開全新 session。開好直接 attach。
  const submitNew = async () => {
    setNewOpen(false);
    setErr(null);
    const extra = args.trim() || undefined;
    try {
      let name: string;
      if (resumeId) {
        ({ name } = await api.startSession(repo, resumeId, { yolo, args: extra }));
      } else {
        const a = agent.trim() || 'claude';
        ({ name } = await api.newSession(repo, { agent: a, yolo, args: extra }));
        setSessionAgent(a); // 記住上次用的 agent
      }
      setResumeId(null);
      setAttached(name);
      setListOpen(false);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // 刪除某 claude session(刪 jsonl;若有對應 live tmux 先收掉)。
  const removeSession = async (id: string, tname: string, live: boolean) => {
    setErr(null);
    try {
      if (live) await api.tmuxKill(tname);
      await api.deleteSession(repo, id);
      if (attached === tname) setAttached(null);
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
                  {label(name)}
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
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openAlias(name)}
                      title="別名"
                    />
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
                  {aliasMap[tname] || s.title}
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
                    onClick={() => {
                      if (live) {
                        void start(s.id); // 已在跑 → 直接接
                      } else {
                        setResumeId(s.id); // 未起 → 開參數 Dialog(YOLO / 額外參數)
                        setYolo(false);
                        setArgs('');
                        setNewOpen(true);
                      }
                    }}
                  >
                    {live ? 'attach' : '開背景並 attach'}
                  </Button>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openAlias(tname)}
                    title="別名"
                  />
                  {live && (
                    <Popconfirm title="收掉這個 tmux session?" onConfirm={() => void kill(tname)}>
                      <Button size="small" danger>
                        收掉
                      </Button>
                    </Popconfirm>
                  )}
                  <Popconfirm
                    title="刪除這個 session?(連同 jsonl 記錄)"
                    okText="刪除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void removeSession(s.id, tname, live)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} title="刪除 session" />
                  </Popconfirm>
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
          onClick={() => {
            setResumeId(null);
            setAgent(getSessionAgent());
            setYolo(false);
            setArgs('');
            setNewOpen(true);
          }}
          title="開全新背景 session(可設 agent / YOLO / 參數)"
          data-loc="session:new"
        >
          新 session
        </Button>
        {tmuxNames.length > 0 && <Tag color="green">{tmuxNames.length} 個背景 tmux</Tag>}
        {attached && (
          <>
            <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }} title={attached}>
              {label(attached)}
            </Typography.Text>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => openAlias(attached)}
              title="設別名"
              data-loc="session:alias"
            />
          </>
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

      <Modal
        title={resumeId ? '恢復 session' : '新 session'}
        open={newOpen}
        onOk={() => void submitNew()}
        onCancel={() => setNewOpen(false)}
        okText={resumeId ? '恢復並 attach' : '開始'}
        cancelText="取消"
        data-loc="session:new:modal"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {resumeId ? (
            <Typography.Text type="secondary">
              恢復 claude session(--resume {resumeId.slice(0, 8)})
            </Typography.Text>
          ) : (
            <div>
              <div style={{ marginBottom: 4 }}>Agent</div>
              <AutoComplete
                value={agent}
                onChange={setAgent}
                options={SESSION_AGENTS.map((a) => ({ value: a }))}
                style={{ width: '100%' }}
                placeholder="claude / gemini / 自訂指令"
                data-loc="session:new:agent"
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch checked={yolo} onChange={setYolo} data-loc="session:new:yolo" />
            <span>YOLO 模式</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              加 --dangerously-skip-permissions(claude:跳過權限確認)
            </Typography.Text>
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>額外參數(選填)</div>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              onPressEnter={() => void submitNew()}
              placeholder="例如 --model opus"
              data-loc="session:new:args"
            />
          </div>
        </div>
      </Modal>

      <Modal
        title="session 別名"
        open={aliasOpen}
        onOk={saveAlias}
        onCancel={() => setAliasOpen(false)}
        okText="儲存"
        cancelText="取消"
        data-loc="session:alias:modal"
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          只改顯示名稱({aliasTarget}),清空則還原。
        </Typography.Paragraph>
        <Input
          value={aliasInput}
          onChange={(e) => setAliasInput(e.target.value)}
          onPressEnter={saveAlias}
          placeholder="好記的別名,例如:重構分支"
          data-loc="session:alias:input"
        />
      </Modal>
    </div>
  );
}
