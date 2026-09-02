/**
 * PathUrlInput — 連結對話框的網址欄,帶 VS Code 式站內路徑自動補全。
 *
 *  - 只有 `.` / `..` / `/` 起手才觸發;`https://` 等外部網址完全不受影響(見 lib/linkPath)。
 *  - `.` = 目前編輯檔所在目錄、`..` = 上一層、`/` = repo 根;繼續打字過濾,
 *    選資料夾補 `/` 續補下一層、選檔案填入並收起。
 *  - 鍵盤:↑↓ 選、Tab/Enter 套用、Esc 關(下拉關著時 Enter 才送出對話框)。
 *  - 列檔複用 `GET /api/:repo/tree`(單層);超出 repo root 由後端 path-guard 擋(403)→ 顯示「已到根」。
 */
import { useEffect, useState } from 'react';
import { Input } from 'antd';
import { FolderFilled, FileOutlined } from '@ant-design/icons';

import { api, type TreeItem } from '../lib/api';
import {
  applyLinkPathChoice,
  parentInsertBase,
  parseLinkPathQuery,
  type LinkPathQuery,
} from '../lib/linkPath';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 下拉關著時按 Enter(= 套用連結)。 */
  onSubmit: () => void;
  /** repo 相對的「目前編輯檔所在目錄」;路徑以此為基準。 */
  baseDir: string;
  placeholder?: string;
}

/** 合成的「上一層」項目 name(不會與真實項目撞名,因為真實項目名不含 '/')。 */
const UP = '../';

export default function PathUrlInput({ value, onChange, onSubmit, baseDir, placeholder }: Props) {
  const repo = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] ?? '');
  // 初始 dismissed:編輯既有連結(網址預填 `./x.md`)時不要一開 dialog 就彈下拉,打字才觸發。
  const [dismissed, setDismissed] = useState(true);
  const [items, setItems] = useState<TreeItem[]>([]);
  const [loadedDir, setLoadedDir] = useState<string | null>(null);
  const [tooDeep, setTooDeep] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const query: LinkPathQuery | null = dismissed ? null : parseLinkPathQuery(value, baseDir);
  const open = query !== null;
  const dir = query?.dir ?? '';
  const prefix = query?.prefix ?? '';

  // 該層清單(path-guard:逃出 repo root → 403 → tooDeep)。
  useEffect(() => {
    if (!open) return;
    if (dir === loadedDir) return;
    let cancelled = false;
    api
      .tree(repo, dir || '.')
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
        setTooDeep(true);
        setActiveIdx(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, dir, loadedDir, repo]);

  // 字首改變 → 高亮拉回頂端。
  useEffect(() => {
    setActiveIdx(0);
  }, [prefix]);

  // 非 repo root 時於頂端插入合成的 `../`;手打 `..` 也會被字首過濾到它。
  const listed: TreeItem[] =
    dir !== '' && !tooDeep ? [{ name: UP, path: `${dir}/..`, type: 'dir' }, ...items] : items;
  // `../` 以 '..' 參與字首過濾(打了字首就讓真實項目排第一,Enter 不會誤跳上層)。
  const filtered = listed.filter((it) =>
    (it.name === UP ? '..' : it.name.toLowerCase()).startsWith(prefix.toLowerCase()),
  );

  const closeMenu = () => {
    setDismissed(true);
    setItems([]);
    setLoadedDir(null);
    setTooDeep(false);
  };

  const handleChange = (next: string) => {
    setDismissed(false); // 一打字就重新評估要不要開
    onChange(next);
  };

  // 選中:`../` 回上層、資料夾補 `/` 續補、檔案填入後收起。
  const choose = (item: TreeItem) => {
    if (!query) return;
    if (item.name === UP) {
      onChange(parentInsertBase(query.insertBase));
      return;
    }
    onChange(applyLinkPathChoice(query, item.name, item.type === 'dir'));
    if (item.type !== 'dir') closeMenu();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      e.stopPropagation(); // 只關下拉,不關 Modal
      closeMenu();
      return;
    }
    if (e.key === 'Enter' && !open) onSubmit();
  };

  return (
    <div style={{ position: 'relative' }}>
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
          data-loc="explore:edit:link:pathhint"
        >
          <div
            style={{
              padding: '4px 12px',
              fontSize: 12,
              color: '#999',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            {dir === '' ? repo : `${repo}/${dir}`}
          </div>
          {tooDeep ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: '#999' }}>已到 repo 根</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: '#999' }}>無相符項目</div>
          ) : (
            filtered.map((it, i) => (
              <div
                key={it.path}
                // onMouseDown 而非 onClick:避免 input 先 blur。
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
                {it.name === UP ? (
                  <span>
                    ../ <span style={{ color: '#999', fontSize: 12 }}>上一層</span>
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
      <Input
        autoFocus
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        data-loc="explore:edit:link:url"
      />
    </div>
  );
}
