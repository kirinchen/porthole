/**
 * Chat tab — 透過 claude -p 跟 active repo 的 agent 對話。
 *  - 左:thread 列表(讀 <repo>/doc/chat/*.md)
 *  - 右:對話內容 + composer
 *  - 送出 → POST /api/:repo/chat,SSE 逐字串回;後端把紀錄 append 到 doc/chat/<thread>.md
 */
import { useEffect, useRef, useState } from 'react';
import { Button, List, Spin, Alert, Typography, Space, Popover, Modal, Input } from 'antd';
import { UnorderedListOutlined, EditOutlined } from '@ant-design/icons';
import { api, type ThreadMeta } from '../lib/api';
import MentionTextArea from '../components/MentionTextArea';
import Markdown from '../components/Markdown';

interface Props {
  repo: string;
  isActive?: boolean; // 是否為目前 active 的右側面板(只有 active 才接收 ContentPick 引用)
}

interface Turn {
  role: 'human' | 'assistant';
  text: string;
}

export default function Chat({ repo, isActive }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [active, setActive] = useState<string>('default');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false); // 頂部 List 選單(thread 列表)
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = isActive !== false;
  }, [isActive]);

  const loadThreads = () => {
    api
      .threads(repo)
      .then((r) => setThreads(r.threads))
      .catch((e: Error) => setErr(e.message));
  };

  // thread 改名:有檔(已對話過)→ 後端 fs.rename;無檔(空 thread)→ 本地改名,下次訊息寫新檔。
  const doRename = async () => {
    const to = renameVal.trim();
    if (!to || to === active) {
      setRenameOpen(false);
      return;
    }
    try {
      const { name } = await api.renameThread(repo, active, to);
      setActive(name);
      loadThreads();
    } catch {
      setActive(to.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default');
    }
    setRenameOpen(false);
  };

  useEffect(() => {
    setThreads([]);
    setTurns([]);
    setActive('default');
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const openThread = async (name: string) => {
    setActive(name);
    setErr(null);
    try {
      const r = await api.thread(repo, name);
      setTurns(parseThread(r.content));
    } catch {
      setTurns([]); // 新 thread
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  // ContentPick 挑到的內容 → 以引用塊附進輸入框(Cursor 式 mention)。只有 active 時收。
  useEffect(() => {
    const onMention = (e: Event) => {
      if (!activeRef.current) return;
      const { text, source } = (e as CustomEvent<{ text: string; source?: string }>).detail || {};
      if (!text) return;
      const body = (source ? `[${source}]\n` : '') + text;
      const quoted = body
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n');
      setInput((prev) => (prev ? `${prev.replace(/\s*$/, '')}\n\n${quoted}\n\n` : `${quoted}\n\n`));
    };
    window.addEventListener('porthole:mention', onMention);
    return () => window.removeEventListener('porthole:mention', onMention);
  }, []);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    const firstTurn = turns.length === 0; // 首輪 → 回覆後請 agent 依主題命名
    setInput('');
    setErr(null);
    setTurns((t) => [...t, { role: 'human', text: prompt }, { role: 'assistant', text: '' }]);
    setStreaming(true);
    try {
      const r = await fetch(`/api/${repo}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread: active, prompt }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await readSse(r.body, (event, data) => {
        if (event === 'delta') {
          const text = (data as { text: string }).text;
          setTurns((t) => {
            const copy = [...t];
            copy[copy.length - 1] = {
              role: 'assistant',
              text: copy[copy.length - 1].text + text,
            };
            return copy;
          });
        } else if (event === 'stderr') {
          // stderr 不顯示在對話,只記 console
          // eslint-disable-next-line no-console
          console.warn('[claude stderr]', (data as { text: string }).text);
        }
      });
      // 首輪結束且 thread 仍是自動名 → 讓 agent 依主題改名
      if (firstTurn && /^thread-\d+$/.test(active)) {
        try {
          const { name } = await api.renameThread(repo, active);
          if (name !== active) setActive(name);
        } catch {
          /* 命名失敗不影響對話 */
        }
      }
      loadThreads();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStreaming(false);
    }
  };

  const newThread = () => {
    const name = `thread-${Date.now()}`;
    setActive(name);
    setTurns([]);
    setListOpen(false);
  };

  const threadList = (
    <div style={{ width: 240, maxHeight: 360, overflow: 'auto' }} data-loc="chat:list">
      <Button block onClick={newThread} style={{ marginBottom: 8 }} data-loc="chat:thread:new">
        + 新對話
      </Button>
      <List
        size="small"
        dataSource={threads}
        locale={{ emptyText: '尚無對話' }}
        renderItem={(t) => (
          <List.Item
            onClick={() => {
              void openThread(t.name);
              setListOpen(false);
            }}
            style={{
              cursor: 'pointer',
              background: t.name === active ? '#e6f4ff' : undefined,
              padding: '6px 8px',
              borderRadius: 4,
            }}
          >
            <Typography.Text ellipsis>{t.name}</Typography.Text>
          </List.Item>
        )}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-loc="chat:root">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
        }}
        data-loc="chat:topbar"
      >
        <Popover
          trigger="click"
          open={listOpen}
          onOpenChange={setListOpen}
          content={threadList}
          placement="bottomLeft"
        >
          <Button icon={<UnorderedListOutlined />} data-loc="chat:list:toggle">
            List
          </Button>
        </Popover>
        <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
          {active}
        </Typography.Text>
        <Button
          size="small"
          icon={<EditOutlined />}
          title="重新命名此 thread"
          onClick={() => {
            setRenameVal(active);
            setRenameOpen(true);
          }}
          data-loc="chat:rename"
        />
      </div>

      <Modal
        title="重新命名 thread"
        open={renameOpen}
        onOk={doRename}
        onCancel={() => setRenameOpen(false)}
        okText="改名"
        cancelText="取消"
        okButtonProps={{ disabled: !renameVal.trim() }}
      >
        <Input
          autoFocus
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onPressEnter={doRename}
          placeholder="thread 名稱(僅 A-Z a-z 0-9 _ -)"
          data-loc="chat:rename:input"
        />
      </Modal>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }} data-loc="chat:messages">
          {err && <Alert type="error" message={err} style={{ marginBottom: 8 }} />}
          {turns.length === 0 && (
            <Typography.Text type="secondary">
              對話寫進 {repo}/doc/chat/{active}.md
            </Typography.Text>
          )}
          {turns.map((turn, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <Typography.Text strong>{turn.role === 'human' ? '🧑 你' : '🤖 agent'}</Typography.Text>
              <div className="md-preview" style={{ marginTop: 4 }}>
                {turn.text ? <Markdown>{turn.text}</Markdown> : <Spin size="small" />}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }}>
          <Space.Compact style={{ width: '100%' }}>
            <MentionTextArea
              repo={repo}
              value={input}
              onChange={setInput}
              onSubmit={() => void send()}
              placeholder={`對 ${repo} 的 agent 說…（@ 提及檔案,Enter 送出,Shift+Enter 換行)`}
              disabled={streaming}
            />
            <Button
              type="primary"
              loading={streaming}
              onClick={() => void send()}
              data-loc="chat:composer:send"
            >
              送出
            </Button>
          </Space.Compact>
        </div>
      </div>
    </div>
  );
}

/** 讀 SSE stream(event: X\ndata: Y\n\n)。 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          /* 壞 frame 忽略 */
        }
      }
    }
  }
}

/** 把 doc/chat/<thread>.md 解析回 turns。格式:## 🧑 Human · / ## 🤖 Assistant · */
function parseThread(md: string): Turn[] {
  const turns: Turn[] = [];
  const parts = md.split(/\n## (?=🧑 Human|🤖 Assistant)/);
  for (const part of parts) {
    const trimmed = part.replace(/^## /, '');
    if (trimmed.startsWith('🧑 Human')) {
      turns.push({ role: 'human', text: stripHeader(trimmed) });
    } else if (trimmed.startsWith('🤖 Assistant')) {
      turns.push({ role: 'assistant', text: stripHeader(trimmed) });
    }
  }
  return turns;
}

function stripHeader(block: string): string {
  const nl = block.indexOf('\n');
  return nl === -1 ? '' : block.slice(nl + 1).trim();
}
