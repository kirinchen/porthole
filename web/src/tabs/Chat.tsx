/**
 * Chat tab — 透過 claude -p 跟 active repo 的 agent 對話。
 *  - 左:thread 列表(讀 <repo>/doc/chat/*.md)
 *  - 右:對話內容 + composer
 *  - 送出 → POST /api/:repo/chat,SSE 逐字串回;後端把紀錄 append 到 doc/chat/<thread>.md
 *
 *  **reload 的兩個坑**(實測:16:01 送出 → 16:03 reload → 16:05 後端才寫完回覆):
 *   1. active thread 存進 URL `?thread=`(換 repo 時由 App 重寫 pathname 自然清掉)——
 *      否則 reload 一律回 default,使用者得自己點回剛才那個 thread。
 *   2. SSE 連線隨 reload 斷掉,但後端那趟 `claude -p` 還在跑、跑完照樣 append 到檔案。
 *      故重開時若**檔尾是 Human turn 沒有 Assistant** → 視為「該輪仍在執行」,顯示提示
 *      並輪詢該檔(POLL_MS / POLL_MAX),回覆一寫進檔案就自動補上;不必使用者手動重整。
 *
 *  **串流狀態是 per thread**(`streamingThreads`,非單一 boolean):在 A 送出後切到 B
 *  還要能繼續送(送出鈕只鎖住正在串流的那個 thread),而且 A 的 delta 只有在 A 仍是
 *  active 時才寫畫面 —— 否則切去 B 後,A 的回覆會逐字接到 B 的對話上。切走那輪不中斷
 *  (後端照跑照寫檔),切回來由上面的輪詢補齊。
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

/** 等「後端仍在跑」那輪回覆的輪詢:5s 一次,最多 5 分鐘(claude -p 深度題目可跑數分鐘)。 */
const POLL_MS = 5000;
const POLL_MAX = 60;

/** URL `?thread=` → thread 名(reload 回到同一個 thread)。 */
function threadFromUrl(): string | null {
  const t = new URLSearchParams(location.search).get('thread');
  return t ? t.trim() || null : null;
}

/** URL 第一段 = repo(與 App 的 repoFromUrl 同規則);popstate 要據此判斷是否同 repo。 */
function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

/**
 * active thread → URL `?thread=`(`default` 則移除參數)。
 * push=true(使用者切 thread / 開新對話)→ 留歷史一筆,上一頁可回前一個 thread;
 * push=false(改名、初次同步)→ replaceState,同一個 thread 換個名字不該多一筆歷史。
 */
function writeThreadUrl(name: string, push = false): void {
  const params = new URLSearchParams(location.search);
  if (name && name !== 'default') params.set('thread', name);
  else params.delete('thread');
  const qs = params.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (url === location.pathname + location.search + location.hash) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

export default function Chat({ repo, isActive }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [active, setActive] = useState<string>(() => threadFromUrl() ?? 'default');
  // 重開後偵測到「上一輪還在後端跑」(檔尾是 Human turn,無 Assistant)→ 顯示提示 + 輪詢。
  const [pendingReply, setPendingReply] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  // 正在串流的 thread 名集合(per thread —— 在 A 送出後切到 B 仍可送出)。
  const [streamingThreads, setStreamingThreads] = useState<Set<string>>(new Set());
  const streaming = streamingThreads.has(active); // 目前這個 thread 是否在串流
  const [err, setErr] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false); // 頂部 List 選單(thread 列表)
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  // active thread 的顯示標題(檔首 H1,可中文);null = 該檔沒標題 → 顯示檔名。
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
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
      // 後端:標題寫進檔首 H1;檔名只在輸入含英數時才改(純中文 → 檔名不動)。
      const { name, title } = await api.renameThread(repo, active, to);
      setActive(name);
      setActiveTitle(title ?? null);
      loadThreads();
    } catch {
      // 無檔(空 thread)→ 本地改名,下次訊息才寫檔;此時檔名仍需收斂成安全字元。
      setActive(to.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default');
      setActiveTitle(null);
    }
    setRenameOpen(false);
  };

  // 換 repo → 清狀態。**初次掛載例外**:沿用 URL `?thread=` 的 thread 並把它讀出來,
  // 否則 reload 後會被這裡重設成 default(= 使用者回報的「refresh 就沒反應」)。
  const didInit = useRef(false);
  useEffect(() => {
    setThreads([]);
    setTurns([]);
    setStreamingThreads(new Set()); // thread 名空間隨 repo 不同,避免同名誤判
    const urlThread = didInit.current ? null : threadFromUrl();
    didInit.current = true;
    if (urlThread) {
      void openThread(urlThread);
    } else {
      setActive('default');
      setActiveTitle(null);
      setPendingReply(false);
    }
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // active → URL 的保底同步(改名 / 自動命名 / 初次掛載):replaceState,不灌歷史。
  // 使用者主動切 thread 的那一筆歷史由 openThread(push) / newThread 負責。
  useEffect(() => {
    writeThreadUrl(active);
  }, [active]);

  /**
   * URL → state(上一頁 / 下一頁)。只在 URL 的 repo 與目前 repo 相同時才接手 ——
   * 跨 repo 的 popstate 由 App 切 repo,接著 Chat 的 repo effect 會重置狀態。
   * 比對 activeRef 式的最新值用 ref,避免 handler 綁到過期的 active。
   */
  const activeThreadRef = useRef(active);
  useEffect(() => {
    activeThreadRef.current = active;
  }, [active]);
  useEffect(() => {
    const onPop = () => {
      if (repoFromUrl() !== repo) return; // 換 repo → 交給 repo effect
      const want = threadFromUrl() ?? 'default';
      if (want === activeThreadRef.current) return;
      void openThread(want);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  /** 開某 thread。push=true(使用者從列表點選)→ 在歷史留一筆,上一頁可回前一個 thread。 */
  const openThread = async (name: string, push = false) => {
    if (push) writeThreadUrl(name, true);
    setActive(name);
    setActiveTitle(threads.find((t) => t.name === name)?.title ?? null);
    setErr(null);
    try {
      const r = await api.thread(repo, name);
      const parsed = parseThread(r.content);
      setTurns(parsed);
      // 檔尾是 Human turn → 那輪的 assistant 還沒寫檔(後端仍在跑:重整過、或在這個
      // thread 送出後切走了)→ 開輪詢等它寫檔。切走那輪的逐字輸出收不回來(SSE 的
      // delta 只在該 thread 仍 active 時才寫畫面),但整段回覆會由輪詢補上。
      setPendingReply(parsed.length > 0 && parsed[parsed.length - 1].role === 'human');
    } catch {
      setTurns([]); // 新 thread
      setPendingReply(false);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  /**
   * 等「reload 前送出、後端仍在跑」那輪的回覆:每 POLL_MS 重讀 thread 檔,
   * 等到 assistant turn 出現(= 後端 append 完)就停。SSE 已隨 reload 斷掉,無法重新
   * attach(那是厚的那層),故退而輪詢檔案 —— 使用者不必自己一直按重整。
   * 上限 POLL_MAX 次;逾時就停(留提示讓使用者自己重讀)。
   */
  useEffect(() => {
    if (!pendingReply) return; // 本畫面在串流時 send() 已把它設成 false
    let tries = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      tries += 1;
      api
        .thread(repo, active)
        .then((r) => {
          const parsed = parseThread(r.content);
          if (parsed.length && parsed[parsed.length - 1].role === 'assistant') {
            setTurns(parsed);
            setPendingReply(false);
            loadThreads(); // 後端可能也在這輪之後自動命名了
          } else if (tries >= POLL_MAX) {
            setPendingReply(false);
          }
        })
        .catch(() => {
          if (tries >= POLL_MAX) setPendingReply(false);
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReply, repo, active]);

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
    const thread = active; // 這一輪綁定的 thread:送出後使用者可能切到別的 thread
    const firstTurn = turns.length === 0; // 首輪 → 回覆後請 agent 依主題命名
    setInput('');
    setErr(null);
    setPendingReply(false); // 這輪有自己的 SSE,輪詢交棒給 streaming
    setTurns((t) => [...t, { role: 'human', text: prompt }, { role: 'assistant', text: '' }]);
    setStreamingThreads((s) => new Set(s).add(thread));
    try {
      const r = await fetch(`/api/${repo}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread, prompt }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await readSse(r.body, (event, data) => {
        if (event === 'delta') {
          // 只在這輪的 thread 仍是 active 時寫畫面 —— 否則會把這個 thread 的回覆
          // 逐字接到使用者已切過去的另一個 thread 上。切走後照收不寫,回來由輪詢補。
          if (activeThreadRef.current !== thread) return;
          const text = (data as { text: string }).text;
          setTurns((t) => {
            const copy = [...t];
            const last = copy[copy.length - 1];
            if (!last || last.role !== 'assistant') return t; // 畫面已換過 → 不亂接
            copy[copy.length - 1] = { role: 'assistant', text: last.text + text };
            return copy;
          });
        } else if (event === 'stderr') {
          // stderr 不顯示在對話,只記 console
          // eslint-disable-next-line no-console
          console.warn('[claude stderr]', (data as { text: string }).text);
        }
      });
      // 首輪結束且 thread 仍是自動名 → 讓 agent 依主題改名
      if (firstTurn && /^thread-\d+$/.test(thread)) {
        try {
          const { name, title } = await api.renameThread(repo, thread);
          // 使用者已切去別的 thread → 只更新列表,不把他拉回來
          if (activeThreadRef.current === thread) {
            if (name !== thread) setActive(name);
            setActiveTitle(title ?? null);
          }
        } catch {
          /* 命名失敗不影響對話 */
        }
      }
      loadThreads();
    } catch (e) {
      if (activeThreadRef.current === thread) setErr((e as Error).message);
    } finally {
      setStreamingThreads((s) => {
        const next = new Set(s);
        next.delete(thread);
        return next;
      });
    }
  };

  const newThread = () => {
    const name = `thread-${Date.now()}`;
    writeThreadUrl(name, true); // 開新對話也留一筆歷史
    setActive(name);
    setActiveTitle(null);
    setTurns([]);
    setPendingReply(false);
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
              void openThread(t.name, true); // 使用者主動切 → 留歷史,上一頁可回上一個 thread
              setListOpen(false);
            }}
            style={{
              cursor: 'pointer',
              background: t.name === active ? '#e6f4ff' : undefined,
              padding: '6px 8px',
              borderRadius: 4,
            }}
          >
            <Typography.Text ellipsis title={t.name} style={{ flex: 1, minWidth: 0 }}>
              {t.title || t.name}
            </Typography.Text>
            {/* 多開時標出哪個 thread 還在跑(送出後切去別的 thread 也看得到) */}
            {streamingThreads.has(t.name) && <Spin size="small" data-loc="chat:thread:running" />}
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
        <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }} title={active}>
          {activeTitle || active}
        </Typography.Text>
        <Button
          size="small"
          icon={<EditOutlined />}
          title="重新命名此 thread"
          onClick={() => {
            setRenameVal(activeTitle || active);
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
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          這裡改的是<Typography.Text strong>顯示標題</Typography.Text>(可用中文),寫進 <Typography.Text code>doc/chat/{active}.md</Typography.Text>{' '}
          的第一行 <Typography.Text code># 標題</Typography.Text>。輸入含英文字母 / 數字時,檔名也會一起改成
          對應 slug;純中文則只改標題、檔名不動。
        </Typography.Paragraph>
        <Input
          autoFocus
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onPressEnter={doRename}
          placeholder="顯示標題(可中文)"
          data-loc="chat:rename:input"
        />
      </Modal>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }} data-loc="chat:messages">
          {err && <Alert type="error" message={err} style={{ marginBottom: 8 }} />}
          {pendingReply && (
            <Alert
              type="info"
              showIcon
              icon={<Spin size="small" />}
              message="這一輪仍在後端執行(送出後重整過頁面,或切去了別的對話)—— 回覆寫進檔案就會自動出現"
              action={
                <Button size="small" onClick={() => void openThread(active)} data-loc="chat:pending:reload">
                  立即重讀
                </Button>
              }
              style={{ marginBottom: 8 }}
              data-loc="chat:pending"
            />
          )}
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
              placeholder={`對 ${repo} 的 agent 說…（@ 提及檔案,⌘/Ctrl+Enter 送出,Enter 換行)`}
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
