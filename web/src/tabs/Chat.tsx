/**
 * Chat — 跟 active repo 的 agent 對話(`claude -p`)。
 *
 * **形狀照 tide 的留言面板**(`tide/src/ui/CommentPanel.tsx`;那支的註解寫著「版面參考
 * porthole 右側 chat」—— 現在反過來抄回來)。訊息是**留言卡**而不是左右氣泡:
 * `@you` / `@<repo>` + 時間 + 🔗 複製該則連結 + markdown 內容。
 *
 * 兩種版面(SPEC §3):
 *  - `panel`(檔案模式的右欄):頂列有 List 選單;`linkPath` 決定開哪一條**綁檔對話**。
 *  - `full`(對話模式):左邊一欄列出全部對話,右邊是對話本體。
 *
 * 幾個踩過的坑,改這支前先讀(細節見 SPEC §4.2):
 *  1. **串流狀態 per thread**(`streamingThreads`,非單一 boolean):A 送出後切到 B 還要能送,
 *     且 A 的 delta 只在 A 仍是 active 時才寫畫面 —— 否則 A 的回覆會逐字接到 B 的畫面上。
 *  2. **首輪自動命名的 setActive 只在使用者仍停在該 thread 時才做**:否則會把人從正在看的
 *     對話拉走,下一則訊息就被寫進錯的檔案(2026-10 真的發生過)。
 *  3. **送出時綁定當下的 thread 名**(`const thread = active`),不要在 callback 裡讀 state。
 *  4. **草稿存在 onChange**,不要用 effect(換 thread 那一瞬間會把 A 的草稿存到 B 名下)。
 *  5. 跑著的那輪由後端 **job registry** 認定(關分頁再回來看得到、停得掉);registry 沒了
 *     (後端重啟)才退回「檔尾是 Human turn」的猜測 + 檔案輪詢。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, List, Spin, Alert, Typography, Popover, Modal, Input, Select, Tooltip } from 'antd';
import {
  UnorderedListOutlined,
  EditOutlined,
  SettingOutlined,
  SendOutlined,
  StopOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api, type ThreadMeta, type ChatJob } from '../lib/api';
import MentionTextArea from '../components/MentionTextArea';
import Markdown from '../components/Markdown';
import { copyText } from '../lib/clipboard';
import {
  clearDraft,
  draftKey,
  getEffort,
  getModel,
  loadDraft,
  pruneDrafts,
  saveDraft,
  setEffort as writeEffort,
  setModel as writeModel,
} from '../lib/chatPrefs';

interface Props {
  repo: string;
  /** 是否為目前 active 的面板(只有 active 才接收 ContentPick 引用)。 */
  isActive?: boolean;
  /** `panel` = 檔案模式右欄;`full` = 對話模式(自帶左側列表)。 */
  layout?: 'panel' | 'full';
  /** 檔案模式:目前開著的檔(repo 相對路徑)→ 自動切到該檔的預設對話(SPEC §4.2.1)。 */
  linkPath?: string | null;
}

interface Turn {
  role: 'human' | 'assistant';
  text: string;
  /** turn 標頭上的 ISO 時間;舊檔解不出來 → 空字串。 */
  at: string;
}

/** 等「後端仍在跑」那輪回覆的輪詢:5s 一次,最多 5 分鐘(claude -p 深度題目可跑數分鐘)。 */
const POLL_MS = 5000;
const POLL_MAX = 60;

/** URL `?thread=` → thread 名(reload 回到同一條對話)。 */
function threadFromUrl(): string | null {
  const t = new URLSearchParams(location.search).get('thread');
  return t ? t.trim() || null : null;
}

/** URL `?turn=` → 第幾則(1-based,deep-link 用);非法 → null。 */
function turnFromUrl(): number | null {
  const n = Number(new URLSearchParams(location.search).get('turn'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** URL 第一段 = repo(與 App 的 repoFromUrl 同規則);popstate 要據此判斷是否同 repo。 */
function repoFromUrl(): string {
  return decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
}

/**
 * active thread → URL `?thread=`(`default` 則移除參數)。
 * **換了對話**才清掉 `?turn=`(那是某一則的錨點,換對話就失效);同一條對話要留著,
 * 否則帶 `?turn=` 進來的 deep-link 會在初次同步時被自己抹掉,重整就跳不回那一則。
 * push=true(使用者切對話 / 開新對話)→ 留歷史一筆;push=false(改名、初次同步)→ replaceState。
 */
function writeThreadUrl(name: string, push = false): void {
  const params = new URLSearchParams(location.search);
  const changed = (params.get('thread') ?? 'default') !== (name || 'default');
  if (name && name !== 'default') params.set('thread', name);
  else params.delete('thread');
  if (changed) params.delete('turn');
  const qs = params.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (url === location.pathname + location.search + location.hash) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

const fmtAt = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export default function Chat({ repo, isActive, layout = 'panel', linkPath }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [active, setActive] = useState<string>(() => threadFromUrl() ?? 'default');
  // active thread 的顯示標題(檔首 H1,可中文);null = 該檔沒標題 → 顯示檔名。
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  // active thread 綁的檔(檔內 link 註記);null = 沒綁。
  const [activeLink, setActiveLink] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  // 正在串流的 thread 名集合(per thread —— 在 A 送出後切到 B 仍可送出)。
  const [streamingThreads, setStreamingThreads] = useState<Set<string>>(new Set());
  const streaming = streamingThreads.has(active);
  // 後端 job registry 說這條還在跑(= 別的分頁 / 重整前送出的那輪)。
  const [job, setJob] = useState<ChatJob | null>(null);
  // registry 查不到(後端重啟過)但檔尾是 Human turn → 可能還在跑,退回檔案輪詢。
  const [pendingReply, setPendingReply] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [cfgOpen, setCfgOpen] = useState(false);
  const [model, setModel] = useState(getModel);
  const [effort, setEffort] = useState(getEffort);
  const [engine, setEngine] = useState<{ models: string[]; efforts: string[] } | null>(null);
  // deep-link `?turn=` 指到的那一則(高亮)。
  const [highlight, setHighlight] = useState<number | null>(() => turnFromUrl());
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = isActive !== false;
  }, [isActive]);

  useEffect(() => {
    pruneDrafts();
  }, []);

  const loadThreads = useCallback(() => {
    api
      .threads(repo)
      .then((r) => setThreads(r.threads))
      .catch((e: Error) => setErr(e.message));
  }, [repo]);

  /** 開某條對話。push=true(使用者從列表點選)→ 在歷史留一筆。 */
  const openThread = useCallback(
    async (name: string, push = false) => {
      if (push) writeThreadUrl(name, true);
      setActive(name);
      setErr(null);
      // 開的正是 URL 指到的那條 → 沿用 `?turn=` 的錨點(deep-link 初次載入會走到這裡);
      // 換成別條就丟掉錨點,否則永遠不自動捲到底。
      setHighlight(name === (threadFromUrl() ?? 'default') ? turnFromUrl() : null);
      setInput(loadDraft(draftKey(repo, name)));
      const meta = threads.find((t) => t.name === name);
      setActiveTitle(meta?.title ?? null);
      setActiveLink(meta?.link ?? null);
      let parsed: Turn[] = [];
      try {
        const r = await api.thread(repo, name);
        parsed = parseThread(r.content);
        setTurns(parsed);
        setActiveLink(parseLink(r.content) ?? meta?.link ?? null);
      } catch {
        setTurns([]); // 新對話(還沒落檔)
      }
      // 跑著的那輪:先問後端 registry(權威)。問不到才看「檔尾是 Human turn」。
      let running: ChatJob | null = null;
      try {
        running = (await api.chatJob(repo, name)).job;
      } catch {
        /* 問不到 → 當作沒有 */
      }
      setJob(running);
      setPendingReply(!running && parsed.length > 0 && parsed[parsed.length - 1].role === 'human');
    },
    [repo, threads],
  );
  // effect / callback 要讀「最新的 openThread」但不想讓它進 deps(threads 一變就重綁)。
  const openRef = useRef(openThread);
  openRef.current = openThread;

  // 換 repo → 清狀態。**初次掛載例外**:沿用 URL `?thread=`,否則 reload 後會被重設成
  // default(= 使用者回報過的「refresh 就沒反應」)。
  const didInit = useRef(false);
  useEffect(() => {
    setThreads([]);
    setTurns([]);
    setStreamingThreads(new Set()); // thread 名空間隨 repo 不同,避免同名誤判
    const urlThread = didInit.current ? null : threadFromUrl();
    didInit.current = true;
    if (urlThread) {
      void openRef.current(urlThread);
    } else {
      setActive('default');
      setActiveTitle(null);
      setActiveLink(null);
      setPendingReply(false);
      setJob(null);
    }
    loadThreads();
  }, [repo, loadThreads]);

  // ⚙ 的選項由後端給(白名單),前端不自己編清單。
  useEffect(() => {
    api
      .chatEngine()
      .then((r) => setEngine({ models: r.models, efforts: r.efforts }))
      .catch(() => setEngine(null));
  }, []);

  /**
   * 檔案模式:開著的檔 → 那個檔的預設對話(SPEC §4.2.1)。
   * URL 帶 `?thread=` 的初次載入讓 URL 贏(deep-link 比「現在開著哪個檔」優先);
   * 之後換檔就跟著換對話。
   */
  const urlThreadWins = useRef(!!threadFromUrl());
  useEffect(() => {
    if (layout !== 'panel' || !linkPath) return;
    if (urlThreadWins.current) {
      urlThreadWins.current = false; // 只讓第一次生效
      return;
    }
    let alive = true;
    api
      .threadForFile(repo, linkPath)
      .then((r) => {
        if (!alive) return;
        if (r.exists) {
          void openRef.current(r.name);
        } else {
          // 還沒有這個檔的對話 → 開一條空的(第一次送出才落檔)
          setActive(r.name);
          setActiveTitle(null);
          setActiveLink(linkPath);
          setTurns([]);
          setPendingReply(false);
          setJob(null);
          setInput(loadDraft(draftKey(repo, r.name)));
        }
      })
      .catch(() => {
        /* 問不到就維持現狀 */
      });
    return () => {
      alive = false;
    };
  }, [repo, linkPath, layout]);

  // active → URL 的保底同步(改名 / 自動命名 / 初次掛載):replaceState,不灌歷史。
  useEffect(() => {
    writeThreadUrl(active);
  }, [active]);

  /**
   * URL → state(上一頁 / 下一頁)。只在 URL 的 repo 與目前 repo 相同時才接手 ——
   * 跨 repo 的 popstate 由 App 切 repo,接著這裡的 repo effect 會重置狀態。
   * 比最新值用 ref,避免 handler 綁到過期的 active。
   */
  const activeThreadRef = useRef(active);
  useEffect(() => {
    activeThreadRef.current = active;
  }, [active]);
  useEffect(() => {
    const onPop = () => {
      if (repoFromUrl() !== repo) return; // 換 repo → 交給 repo effect
      setHighlight(turnFromUrl());
      const want = threadFromUrl() ?? 'default';
      if (want === activeThreadRef.current) return;
      void openRef.current(want);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [repo]);

  // 新訊息 → 捲到底。deep-link `?turn=` 指定某一則時不搶,交給下面那個 effect。
  useEffect(() => {
    if (highlight != null) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, highlight]);

  // deep-link:捲到 `?turn=N` 那一則。渲染完才捲(等 markdown 撐開高度)。
  useEffect(() => {
    if (highlight == null || turns.length === 0) return;
    const t = window.setTimeout(() => {
      document.getElementById(`ph-turn-${highlight}`)?.scrollIntoView({ block: 'center' });
    }, 80);
    return () => window.clearTimeout(t);
  }, [highlight, turns.length]);

  /**
   * 跑著的那輪:每 POLL_MS 重讀對話檔 + 問一次 job。
   * 為什麼要輪詢:SSE 連線隨 reload / 關分頁斷掉,但後端那趟 claude -p 還在跑、跑完照樣
   * append 到檔案。重新 attach 串流(回看逐字輸出)要後端緩衝輸出,那是厚的那層,沒做。
   * 本畫面自己在串流時不輪詢(SSE 已經在餵畫面)。
   */
  const watching = !streaming && (job !== null || pendingReply);
  useEffect(() => {
    if (!watching) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      tries += 1;
      void (async () => {
        try {
          const [{ content }, { job: j }] = await Promise.all([
            api.thread(repo, active),
            api.chatJob(repo, active).catch(() => ({ job: null as ChatJob | null })),
          ]);
          if (stopped) return;
          const parsed = parseThread(content);
          setTurns(parsed);
          setJob(j);
          const done = parsed.length > 0 && parsed[parsed.length - 1].role === 'assistant';
          if (!j && done) {
            setPendingReply(false);
            loadThreads(); // 後端可能也在這輪之後自動命名了
          } else if (!j && tries >= POLL_MAX) {
            setPendingReply(false);
          }
        } catch {
          if (tries >= POLL_MAX) setPendingReply(false);
        }
      })();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watching, repo, active, loadThreads]);

  // 打字就存草稿(debounce 400ms)。刻意做在 onChange 而非 useEffect —— 見檔頭第 4 點。
  const saveTimer = useRef<number | undefined>(undefined);
  const onInput = useCallback(
    (next: string | ((prev: string) => string)) => {
      setInput((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        window.clearTimeout(saveTimer.current);
        const key = draftKey(repo, activeThreadRef.current);
        saveTimer.current = window.setTimeout(() => saveDraft(key, v), 400);
        return v;
      });
    },
    [repo],
  );
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

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
      onInput((prev) => (prev ? `${prev.replace(/\s*$/, '')}\n\n${quoted}\n\n` : `${quoted}\n\n`));
    };
    window.addEventListener('porthole:mention', onMention);
    return () => window.removeEventListener('porthole:mention', onMention);
  }, [onInput]);

  // thread 改名:有檔(已對話過)→ 後端 fs.rename;無檔(空 thread)→ 本地改名,下次訊息寫新檔。
  const doRename = async () => {
    const to = renameVal.trim();
    if (!to || to === active) {
      setRenameOpen(false);
      return;
    }
    try {
      // 後端:標題寫進檔首 H1;檔名只在輸入含英數時才改(純中文 → 檔名不動);
      // 綁檔的只換 slug 段,後綴不動。
      const { name, title, link } = await api.renameThread(repo, active, to);
      setActive(name);
      setActiveTitle(title ?? null);
      setActiveLink(link ?? null);
      loadThreads();
    } catch {
      // 無檔(空 thread)→ 本地改名,下次訊息才寫檔;此時檔名仍需收斂成安全字元。
      setActive(to.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'default');
      setActiveTitle(null);
    }
    setRenameOpen(false);
  };

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    const thread = active; // 這一輪綁定的 thread:送出後使用者可能切到別的對話
    const firstTurn = turns.length === 0; // 首輪 → 回覆後請 agent 依主題命名
    const link = activeLink ?? (layout === 'panel' ? (linkPath ?? null) : null);
    setInput('');
    clearDraft(draftKey(repo, thread));
    setErr(null);
    setPendingReply(false); // 這輪有自己的 SSE,輪詢交棒給 streaming
    setJob(null);
    setHighlight(null);
    const at = new Date().toISOString();
    setTurns((t) => [...t, { role: 'human', text: prompt, at }, { role: 'assistant', text: '', at }]);
    setStreamingThreads((s) => new Set(s).add(thread));
    try {
      const r = await fetch(`/api/${repo}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread,
          prompt,
          link: link ?? undefined,
          model: model || undefined,
          effort: effort || undefined,
        }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await readSse(r.body, (event, data) => {
        if (event === 'delta') {
          // 只在這輪的 thread 仍是 active 時寫畫面 —— 否則會把這條的回覆逐字接到
          // 使用者已切過去的另一條上。切走後照收不寫,回來由輪詢補。
          if (activeThreadRef.current !== thread) return;
          const text = (data as { text: string }).text;
          setTurns((t) => {
            const copy = [...t];
            const last = copy[copy.length - 1];
            if (!last || last.role !== 'assistant') return t; // 畫面已換過 → 不亂接
            copy[copy.length - 1] = { ...last, text: last.text + text };
            return copy;
          });
        } else if (event === 'stderr') {
          // stderr 不顯示在對話,只記 console
          // eslint-disable-next-line no-console
          console.warn('[claude stderr]', (data as { text: string }).text);
        }
      });
      // 首輪結束且還是自動名(`thread-<ts>` / 綁檔的 `chat-…`)→ 讓 agent 依主題改名
      if (firstTurn && (/^thread-\d+$/.test(thread) || thread.startsWith('chat-'))) {
        try {
          const { name, title, link: lk } = await api.renameThread(repo, thread);
          // 使用者已切去別的對話 → 只更新列表,不把他拉回來
          if (activeThreadRef.current === thread) {
            if (name !== thread) setActive(name);
            setActiveTitle(title ?? null);
            setActiveLink(lk ?? null);
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

  /** 中斷:停掉後端那支 claude -p(已寫出的 turn 不回捲)。 */
  const stop = async () => {
    try {
      await api.cancelChat(repo, active);
      setJob(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /**
   * 開新對話。
   *  - 檔案模式(panel + 開著某個檔)→ 再開**一條綁同一個檔的**(列表只列這個檔的,
   *    開一條不綁檔的會當場從列表消失)。名字跟後端要,避免撞到既有的。
   *  - 對話模式 → `thread-<ts>`,不綁檔(行為同舊版)。
   */
  const newThread = async () => {
    setListOpen(false);
    const linked = layout === 'panel' && linkPath ? linkPath : null;
    let name = `thread-${Date.now()}`;
    if (linked) {
      try {
        name = (await api.threadForFile(repo, linked, true)).name;
      } catch {
        /* 問不到就退回不綁檔的預設名 */
      }
    }
    writeThreadUrl(name, true); // 開新對話也留一筆歷史
    setActive(name);
    setActiveTitle(null);
    setActiveLink(linked);
    setTurns([]);
    setPendingReply(false);
    setJob(null);
    setHighlight(null);
    setInput('');
  };

  /** 複製某一則的 deep-link(`?thread=…&turn=N`,保留模式 hash)。 */
  const copyTurnLink = (n: number) => {
    const params = new URLSearchParams(location.search);
    if (active && active !== 'default') params.set('thread', active);
    params.set('turn', String(n));
    copyText(`${location.origin}${location.pathname}?${params.toString()}${location.hash}`);
  };

  /** 點綁的檔 → 切到檔案模式並開那個檔(交給 App / Explore 接手)。 */
  const openLinked = (rel: string) => {
    window.dispatchEvent(
      new CustomEvent('porthole:navigate', { detail: { repo, path: rel, tab: 'file' } }),
    );
  };

  /**
   * 檔案模式只列**這個檔的**對話(SPEC §4.2.1)—— 右欄的身分就是「這個檔的對話」,
   * 把整個 repo 的對話都倒出來反而找不到東西。正在看的那條一定留著(可能還沒落檔,
   * 所以不在 threads 裡)。對話模式(`full`)則列全部。
   */
  const fileScoped = layout === 'panel' && !!linkPath;
  const shownThreads = fileScoped
    ? threads.filter((t) => t.link === linkPath || t.name === active)
    : threads;

  const threadRows = (
    <>
      <Button
        block
        icon={<PlusOutlined />}
        onClick={() => void newThread()}
        style={{ marginBottom: 8 }}
        title={fileScoped ? `再開一條綁著 ${linkPath} 的對話` : '開一條不綁檔的新對話'}
        data-loc="chat:thread:new"
      >
        新對話
      </Button>
      {fileScoped && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          只列綁著 {linkPath} 的對話
        </Typography.Text>
      )}
      <List
        size="small"
        dataSource={shownThreads}
        locale={{ emptyText: fileScoped ? '這個檔還沒有對話' : '尚無對話' }}
        renderItem={(t) => (
          <List.Item
            onClick={() => {
              void openThread(t.name, true); // 使用者主動切 → 留歷史,上一頁可回上一條
              setListOpen(false);
            }}
            style={{
              cursor: 'pointer',
              background: t.name === active ? 'var(--accent-soft)' : undefined,
              padding: '6px 8px',
              borderRadius: 6,
              display: 'block',
            }}
            data-loc="chat:thread:item"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Typography.Text ellipsis title={t.name} style={{ flex: 1, minWidth: 0 }}>
                {t.title || t.name}
              </Typography.Text>
              {/* 多開時標出哪條還在跑(送出後切去別的對話也看得到) */}
              {streamingThreads.has(t.name) && <Spin size="small" data-loc="chat:thread:running" />}
            </div>
            {t.link && (
              <Typography.Text
                type="secondary"
                ellipsis
                style={{ fontSize: 11 }}
                title={`綁著 ${t.link}`}
              >
                <FileTextOutlined /> {t.link}
              </Typography.Text>
            )}
          </List.Item>
        )}
      />
    </>
  );

  const cfg = (
    <div style={{ width: 220 }} data-loc="chat:cfg">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        留「預設」就用 claude CLI 自己的設定
      </Typography.Text>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Select
          value={model}
          onChange={(v) => {
            setModel(v);
            writeModel(v);
          }}
          options={[
            { value: '', label: 'model:預設' },
            ...(engine?.models ?? []).map((m) => ({ value: m, label: `model:${m}` })),
          ]}
          data-loc="chat:cfg:model"
        />
        <Select
          value={effort}
          onChange={(v) => {
            setEffort(v);
            writeEffort(v);
          }}
          options={[
            { value: '', label: 'effort:預設' },
            ...(engine?.efforts ?? []).map((x) => ({ value: x, label: `effort:${x}` })),
          ]}
          data-loc="chat:cfg:effort"
        />
      </div>
    </div>
  );

  const conversation = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
        }}
        data-loc="chat:topbar"
      >
        {layout === 'panel' && (
          <Popover
            trigger="click"
            open={listOpen}
            onOpenChange={setListOpen}
            content={<div style={{ width: 260, maxHeight: 380, overflow: 'auto' }} data-loc="chat:list">{threadRows}</div>}
            placement="bottomLeft"
          >
            <Button
              icon={<UnorderedListOutlined />}
              title={fileScoped ? `${linkPath} 的對話` : '對話列表'}
              data-loc="chat:list:toggle"
            />
          </Popover>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text ellipsis style={{ display: 'block' }} title={active}>
            {activeTitle || active}
          </Typography.Text>
          {activeLink && (
            <span
              className="ph-chat-link"
              title={`這條對話綁著 ${activeLink}(點開那個檔)`}
              onClick={() => openLinked(activeLink)}
              data-loc="chat:link"
            >
              <FileTextOutlined /> {activeLink}
            </span>
          )}
        </div>
        <Button
          size="small"
          icon={<EditOutlined />}
          title="重新命名這條對話"
          onClick={() => {
            setRenameVal(activeTitle || active);
            setRenameOpen(true);
          }}
          data-loc="chat:rename"
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }} data-loc="chat:messages">
        {err && <Alert type="error" message={err} closable onClose={() => setErr(null)} style={{ marginBottom: 8 }} />}
        {(job || pendingReply) && !streaming && (
          <Alert
            type="info"
            showIcon
            icon={<Spin size="small" />}
            message={
              job
                ? `這輪仍在後端執行(${new Date(job.startedAt).toLocaleTimeString()} 起${
                    [job.model, job.effort].filter(Boolean).join(' · ')
                      ? `,${[job.model, job.effort].filter(Boolean).join(' · ')}`
                      : ''
                  })—— 回覆寫進檔案就會自動出現`
                : '這輪可能仍在後端執行(重整過頁面,或切去了別的對話)—— 回覆寫進檔案就會自動出現'
            }
            action={
              <>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void openThread(active)} data-loc="chat:pending:reload">
                  重讀
                </Button>
                {job && (
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => void stop()} data-loc="chat:pending:stop">
                    中斷
                  </Button>
                )}
              </>
            }
            style={{ marginBottom: 8 }}
            data-loc="chat:pending"
          />
        )}
        {turns.length === 0 && !job && (
          <Typography.Text type="secondary">
            {activeLink
              ? `這條對話綁著 ${activeLink};送出後寫進 ${repo}/doc/chat/${active}.md`
              : `對話寫進 ${repo}/doc/chat/${active}.md`}
          </Typography.Text>
        )}
        <ul className="ph-chat-list">
          {turns.map((turn, i) => (
            <li
              key={i}
              id={`ph-turn-${i + 1}`}
              className={`ph-turn${highlight === i + 1 ? ' target' : ''}`}
              data-loc="chat:turn"
            >
              <div className="ph-turn-head">
                <span className="ph-turn-who">{turn.role === 'human' ? '@you' : `@${repo}`}</span>
                <span className="ph-turn-at">{fmtAt(turn.at)}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="ph-turn-link"
                  title="複製這一則的連結"
                  onClick={() => copyTurnLink(i + 1)}
                  data-loc="chat:turn:link"
                >
                  🔗
                </button>
              </div>
              <div className="md-preview">
                {turn.text ? <Markdown>{turn.text}</Markdown> : <Spin size="small" />}
              </div>
            </li>
          ))}
        </ul>
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: '1px solid var(--line)', padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <MentionTextArea
              repo={repo}
              value={input}
              onChange={onInput}
              onSubmit={() => void send()}
              placeholder={`對 ${repo} 的 agent 說…（@ 提及檔案,⌘/Ctrl+Enter 送出,Enter 換行)`}
              disabled={streaming}
            />
          </div>
          <Popover trigger="click" open={cfgOpen} onOpenChange={setCfgOpen} content={cfg} placement="topRight">
            <Button
              icon={<SettingOutlined />}
              type={model || effort ? 'primary' : 'default'}
              ghost={!!(model || effort)}
              title={`model / effort(目前:${[model || '預設', effort || '預設'].join(' · ')})`}
              data-loc="chat:cfg:toggle"
            />
          </Popover>
          {streaming || job ? (
            <Tooltip title="中斷這輪(已寫出的紀錄不回捲)">
              <Button danger icon={<StopOutlined />} onClick={() => void stop()} data-loc="chat:composer:stop">
                中斷
              </Button>
            </Tooltip>
          ) : (
            <Button type="primary" icon={<SendOutlined />} onClick={() => void send()} data-loc="chat:composer:send">
              送出
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-loc="chat:root">
      {layout === 'full' && (
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid var(--line)',
            background: 'var(--surface)',
            overflow: 'auto',
            padding: 8,
          }}
          data-loc="chat:list"
        >
          {threadRows}
        </div>
      )}
      {conversation}

      <Modal
        title="重新命名這條對話"
        open={renameOpen}
        onOk={doRename}
        onCancel={() => setRenameOpen(false)}
        okText="改名"
        cancelText="取消"
        okButtonProps={{ disabled: !renameVal.trim() }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          這裡改的是<Typography.Text strong>顯示標題</Typography.Text>(可用中文),寫進{' '}
          <Typography.Text code>doc/chat/{active}.md</Typography.Text> 的第一行{' '}
          <Typography.Text code># 標題</Typography.Text>。輸入含英文字母 / 數字時,檔名也會一起改成
          對應 slug;純中文則只改標題、檔名不動。
          {activeLink && '綁檔的對話只換檔名前段,後綴(檔名 + 資料夾雜湊)不動。'}
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

/** 檔內的 `<!-- porthole:link <rel> -->` → 綁的檔;沒有則 null(同後端 chat-link.readLink)。 */
function parseLink(md: string): string | null {
  const m = /<!--\s*porthole:link\s+(\S[^>]*?)\s*-->/.exec(md);
  return m ? m[1].trim() : null;
}

/** 把 doc/chat/<thread>.md 解析回 turns。格式:## 🧑 Human · <ISO> / ## 🤖 Assistant · <ISO> */
function parseThread(md: string): Turn[] {
  const turns: Turn[] = [];
  const parts = md.split(/\n## (?=🧑 Human|🤖 Assistant)/);
  for (const part of parts) {
    const trimmed = part.replace(/^## /, '');
    const role = trimmed.startsWith('🧑 Human')
      ? ('human' as const)
      : trimmed.startsWith('🤖 Assistant')
        ? ('assistant' as const)
        : null;
    if (!role) continue;
    const nl = trimmed.indexOf('\n');
    const head = nl === -1 ? trimmed : trimmed.slice(0, nl);
    const at = /·\s*(\S+)\s*$/.exec(head)?.[1] ?? '';
    turns.push({ role, text: nl === -1 ? '' : trimmed.slice(nl + 1).trim(), at });
  }
  return turns;
}
