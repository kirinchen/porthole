/**
 * MentionTextArea — composer 用的 textarea,支援 @ mention 檔案。
 *
 *  - 游標前出現 `@token`(@ 在行首或空白後)即觸發檔案 hint 下拉。
 *  - 路徑導航:選資料夾 → 補 `/` 續查下一層;打 `../` 回上層。
 *    超出 repo root → 後端 path-guard 回 403,下拉顯示提示而非報錯(安全邊界靠 code)。
 *  - 選檔案 → 插入 `@<repo 相對路徑>`(claude -p 原生吃 @file,語意正確)。
 *  - 鍵盤:↑↓ 移動、Enter/Tab 選中、Esc 關;下拉關閉時 Enter 才送出。
 *  - 列檔複用 GET /api/:repo/tree(單層),prefix 在前端過濾。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import type { GetRef } from 'antd';
import { FolderFilled, FileOutlined } from '@ant-design/icons';

type TextAreaRef = GetRef<typeof Input.TextArea>;
import { api, type TreeItem } from '../lib/api';

interface Props {
  repo: string;
  value: string;
  onChange: (value: string) => void;
  /** 下拉關閉時按 Enter(無 Shift)。 */
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
}

interface Mention {
  /** value 中 `@` 的索引。 */
  at: number;
  /** `@` 之後到游標的文字。 */
  query: string;
}

/** 偵測游標前是否正在打 `@token`。@ 必須在行首或空白後,且後續不含空白/@。 */
function detect(value: string, cursor: number): Mention | null {
  const head = value.slice(0, cursor);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(head);
  if (!m) return null;
  const query = m[1];
  return { at: cursor - query.length - 1, query };
}

/** query → 要列的目錄(相對 repo root)+ 用來過濾的 prefix。 */
function splitQuery(query: string): { dir: string; prefix: string } {
  const slash = query.lastIndexOf('/');
  if (slash === -1) return { dir: '.', prefix: query };
  return { dir: query.slice(0, slash) || '.', prefix: query.slice(slash + 1) };
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
  const [mention, setMention] = useState<Mention | null>(null);
  const [items, setItems] = useState<TreeItem[]>([]);
  const [loadedDir, setLoadedDir] = useState<string | null>(null);
  const [tooDeep, setTooDeep] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const pendingCursor = useRef<number | null>(null);

  const open = mention !== null;
  const { dir, prefix } = mention ? splitQuery(mention.query) : { dir: '.', prefix: '' };
  const filtered = items.filter((it) => it.name.toLowerCase().startsWith(prefix.toLowerCase()));

  // 取得底層 textarea DOM(設游標位置用)。
  const textArea = () => ref.current?.resizableTextArea?.textArea ?? null;

  // dir 變更時拉該層清單(path-guard:超出 root → 403)。
  useEffect(() => {
    if (!open) return;
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
  }, [open, dir, loadedDir, repo]);

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
    setMention(detect(next, cursor));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    setMention(detect(next, e.target.selectionStart));
  };

  // 選中一項:資料夾補 `/` 續查,檔案插入後關閉。
  const choose = (item: TreeItem) => {
    if (!mention) return;
    const newQuery =
      (dir === '.' ? '' : dir + '/') + item.name + (item.type === 'dir' ? '/' : '');
    const ta = textArea();
    const cursor = ta ? ta.selectionStart : mention.at + 1 + mention.query.length;
    const tail = value.slice(cursor);
    const before = value.slice(0, mention.at) + '@' + newQuery;
    onChange(before + tail);
    const newCursor = before.length;
    pendingCursor.current = newCursor;
    if (item.type === 'dir') {
      setMention({ at: mention.at, query: newQuery }); // 續查下一層
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
    if (e.key === 'Enter' && !e.shiftKey && !open) {
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
            background: '#fff',
            border: '1px solid #d9d9d9',
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
              color: '#999',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            {dir === '.' ? repo : `${repo}/${dir}`}
          </div>
          {tooDeep ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: '#999' }}>已到 repo 根</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: '#999' }}>無相符項目</div>
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
                  background: i === activeIdx ? '#e6f4ff' : undefined,
                }}
              >
                {it.type === 'dir' ? (
                  <FolderFilled style={{ color: '#faad14' }} />
                ) : (
                  <FileOutlined style={{ color: '#8c8c8c' }} />
                )}
                <span>
                  {it.name}
                  {it.type === 'dir' ? '/' : ''}
                </span>
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
