/**
 * MentionTextArea — composer 用的 textarea,兩種 mention(觸發規則見 lib/mentionToken):
 *
 *  - `@` → **tag agent**:列 basePath 下的兄弟 repo(= `../*`,不含自己),選了插入 `@<repo> `。
 *  - `.` → **叫檔案**:列 repo 內檔案,選了插入 `./<repo 相對路徑>`。
 *    路徑導航:選資料夾 → 補 `/` 續查下一層;`..` 回上層。超出 repo root → 後端 path-guard
 *    回 403,下拉顯示提示而非報錯(安全邊界靠 code)。列檔複用 GET /api/:repo/tree(單層)。
 *  - 鍵盤:↑↓ 移動、Enter/Tab 選中、Esc 關;下拉關閉時 Enter 換行、⌘/Ctrl+Enter 送出。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import type { GetRef } from 'antd';
import { FolderFilled, FileOutlined, RobotOutlined } from '@ant-design/icons';

type TextAreaRef = GetRef<typeof Input.TextArea>;
import { api, type TreeItem } from '../lib/api';
import { detectMention, splitFileQuery, fileMentionText, type MentionToken } from '../lib/mentionToken';

interface Props {
  repo: string;
  value: string;
  onChange: (value: string) => void;
  /** 下拉關閉時按 ⌘/Ctrl+Enter。 */
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function MentionTextArea({
  repo,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
}: Props) {
  const ref = useRef<TextAreaRef>(null);
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [agents, setAgents] = useState<string[] | null>(null); // 兄弟 repo,第一次打 @ 才拉
  const [items, setItems] = useState<TreeItem[]>([]);
  const [loadedDir, setLoadedDir] = useState<string | null>(null);
  const [tooDeep, setTooDeep] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const pendingCursor = useRef<number | null>(null);

  const kind = mention?.kind ?? null;
  const isFile = kind === 'file';
  const { dir, prefix } =
    mention?.kind === 'file' ? splitFileQuery(mention.query) : { dir: '.', prefix: mention?.query ?? '' };
  // 非 repo root 時於頂端插入合成的 `..`(上一層);手打 `..` 也會被 prefix 過濾到它。
  const listed: TreeItem[] = !isFile
    ? (agents ?? []).filter((a) => a !== repo).map((a) => ({ name: a, path: a, type: 'dir' }))
    : dir !== '.' && !tooDeep
      ? [{ name: '..', path: `${dir}/..`, type: 'dir' }, ...items]
      : items;
  const filtered = listed.filter((it) => it.name.toLowerCase().startsWith(prefix.toLowerCase()));
  // `.` 也是一般標點:根目錄下打 `...`、`.)` 這種沒對到任何檔的,不要跳一個空下拉擋路。
  const open =
    mention !== null && (!isFile || dir !== '.' || tooDeep || filtered.length > 0 || loadedDir !== '.');

  // 取得底層 textarea DOM(設游標位置用)。
  const textArea = () => ref.current?.resizableTextArea?.textArea ?? null;

  // 第一次打 @ → 拉 repo 清單(= 可 tag 的 agent)。
  useEffect(() => {
    if (kind !== 'agent' || agents !== null) return;
    api
      .repos()
      .then((r) => setAgents(r.repos))
      .catch(() => setAgents([]));
  }, [kind, agents]);

  // dir 變更時拉該層清單(path-guard:超出 root → 403)。
  useEffect(() => {
    if (!isFile) return;
    if (dir === loadedDir) return;
    let cancelled = false;
    api
      .tree(repo, dir)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setLoadedDir(dir);
        setTooDeep(false);
        setActiveIdx(0);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setLoadedDir(dir);
        setTooDeep(true); // 多半是逃出 repo root 被擋
        setActiveIdx(0);
      });
    return () => {
      cancelled = true;
    };
  }, [isFile, dir, loadedDir, repo]);

  // prefix 變更時把高亮拉回頂端。
  useEffect(() => {
    setActiveIdx(0);
  }, [prefix]);

  // 插入後還原游標位置。
  useLayoutEffect(() => {
    if (pendingCursor.current === null) return;
    const ta = textArea();
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pendingCursor.current, pendingCursor.current);
    }
    pendingCursor.current = null;
  });

  const closeMenu = () => {
    setMention(null);
    setItems([]);
    setLoadedDir(null);
    setTooDeep(false);
  };

  const syncFromTextArea = (next: string) => {
    const ta = textArea();
    const cursor = ta ? ta.selectionStart : next.length;
    setMention(detectMention(next, cursor));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    setMention(detectMention(next, e.target.selectionStart));
  };

  // 把 mention token 換成 text,游標放在 text 尾。
  const replaceToken = (m: MentionToken, text: string): number => {
    const ta = textArea();
    const cursor = ta ? ta.selectionStart : m.at + m.len;
    const before = value.slice(0, m.at) + text;
    onChange(before + value.slice(cursor));
    pendingCursor.current = before.length;
    return before.length;
  };

  // 選中一項:agent 插入 `@<repo> ` 後關閉;檔案這邊 `..` 乾淨回上一層,資料夾補 `/` 續查,
  // 檔案插入後關閉。
  const choose = (item: TreeItem) => {
    if (!mention) return;
    if (mention.kind === 'agent') {
      replaceToken(mention, `@${item.name} `);
      closeMenu();
      return;
    }
    let newQuery: string;
    if (item.name === '..' && item.type === 'dir') {
      const slash = dir.lastIndexOf('/');
      const parent = slash === -1 ? '.' : dir.slice(0, slash);
      newQuery = parent === '.' ? '' : parent + '/';
    } else {
      newQuery = (dir === '.' ? '' : dir + '/') + item.name + (item.type === 'dir' ? '/' : '');
    }
    const text = fileMentionText(newQuery);
    replaceToken(mention, text);
    if (item.type === 'dir') {
      setMention({ kind: 'file', at: mention.at, len: text.length, query: newQuery }); // 續查下一層
    } else {
      closeMenu();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(filtered[activeIdx]);
        return;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    // 送出:⌘/Ctrl+Enter。純 Enter 換行(保留多行輸入,不誤送)。
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !open) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            marginBottom: 4,
            maxHeight: 240,
            overflow: 'auto',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
            zIndex: 1000,
          }}
          data-loc="chat:composer:mention"
        >
          <div
            style={{
              padding: '4px 12px',
              fontSize: 12,
              color: 'var(--muted)',
              borderBottom: '1px solid var(--line)',
            }}
          >
            {!isFile ? 'agent(../*)' : dir === '.' ? repo : `${repo}/${dir}`}
          </div>
          {!isFile && agents === null ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>載入中…</div>
          ) : tooDeep && isFile ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>已到 repo 根</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>無相符項目</div>
          ) : (
            filtered.map((it, i) => (
              <div
                key={it.path}
                // onMouseDown 而非 onClick:避免 textarea 先 blur 丟失游標。
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(it);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  background: i === activeIdx ? 'var(--accent-soft)' : undefined,
                }}
              >
                {!isFile ? (
                  <RobotOutlined style={{ color: 'var(--accent)' }} />
                ) : it.type === 'dir' ? (
                  <FolderFilled style={{ color: '#faad14' }} />
                ) : (
                  <FileOutlined style={{ color: 'var(--muted)' }} />
                )}
                {!isFile ? (
                  <span>
                    @{it.name} <span style={{ color: 'var(--muted)', fontSize: 12 }}>../{it.name}</span>
                  </span>
                ) : it.name === '..' && it.type === 'dir' ? (
                  <span>
                    ../ <span style={{ color: 'var(--muted)', fontSize: 12 }}>上一層</span>
                  </span>
                ) : (
                  <span>
                    {it.name}
                    {it.type === 'dir' ? '/' : ''}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
      <Input.TextArea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(e) => syncFromTextArea((e.target as HTMLTextAreaElement).value)}
        placeholder={placeholder}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 6 }}
        data-loc="chat:composer:input"
      />
    </div>
  );
}
