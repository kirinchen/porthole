/**
 * Chat tab — 透過 claude -p 跟 active repo 的 agent 對話。
 *  - 左:thread 列表(讀 <repo>/doc/chat/*.md)
 *  - 右:對話內容 + composer
 *  - 送出 → POST /api/:repo/chat,SSE 逐字串回;後端把紀錄 append 到 doc/chat/<thread>.md
 */
import { useEffect, useRef, useState } from 'react';
import { Input, Button, List, Spin, Alert, Typography, Space } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type ThreadMeta } from '../lib/api';

interface Props {
  repo: string;
}

interface Turn {
  role: 'human' | 'assistant';
  text: string;
}

export default function Chat({ repo }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [active, setActive] = useState<string>('default');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = () => {
    api
      .threads(repo)
      .then((r) => setThreads(r.threads))
      .catch((e: Error) => setErr(e.message));
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

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
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
  };

  return (
    <div style={{ display: 'flex', height: '100%' }} data-loc="chat:root">
      <div style={{ width: 220, borderRight: '1px solid #f0f0f0', padding: 8, overflow: 'auto' }}>
        <Button block onClick={newThread} style={{ marginBottom: 8 }} data-loc="chat:thread:new">
          + 新對話
        </Button>
        <List
          size="small"
          dataSource={threads}
          locale={{ emptyText: '尚無對話' }}
          renderItem={(t) => (
            <List.Item
              onClick={() => openThread(t.name)}
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

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }} data-loc="chat:messages">
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
                {turn.text ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
                ) : (
                  <Spin size="small" />
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`對 ${repo} 的 agent 說…(Enter 送出,Shift+Enter 換行)`}
              autoSize={{ minRows: 1, maxRows: 6 }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              data-loc="chat:composer:input"
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
