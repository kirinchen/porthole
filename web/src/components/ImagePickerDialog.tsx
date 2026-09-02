/**
 * ImagePickerDialog — 編輯 markdown 時「插入圖片」的 GUI dialog。
 *
 *  - 瀏覽 repo 內圖片:可鑽入資料夾、上一層,圖片以縮圖顯示;點縮圖 → 插入 `![](相對路徑)`。
 *  - 上傳新圖:從電腦選檔 → 存到「目前瀏覽的目錄」(base64,path-guard)→ 立即出現在清單。
 *  - 相對路徑以「目前編輯檔所在目錄」為基準算出(與貼上圖片一致,預覽 MdImg 解析成 raw)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button, Spin, Empty, Breadcrumb } from 'antd';
import { FolderFilled, UploadOutlined, ArrowUpOutlined } from '@ant-design/icons';

import { api, type TreeItem } from '../lib/api';
import { encodeLinkSegment } from '../lib/linkPath';

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const isImageName = (name: string) => IMG_EXT.has(name.split('.').pop()?.toLowerCase() ?? '');

const parentOf = (dir: string) => {
  const i = dir.lastIndexOf('/');
  return i === -1 ? '' : dir.slice(0, i);
};
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** 從 fromDir 到 toPath 的相對路徑(逐段 encode 破壞語法字元;同/子目錄補 `./`)。 */
function relPath(fromDir: string, toPath: string): string {
  const a = fromDir ? fromDir.split('/') : [];
  const b = toPath.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const parts = [...a.slice(i).map(() => '..'), ...b.slice(i).map(encodeLinkSegment)];
  const rel = parts.join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

interface Props {
  repo: string;
  /** 目前編輯檔所在目錄(repo 相對);相對路徑以此為基準、上傳預設也存這。 */
  baseDir: string;
  open: boolean;
  onClose: () => void;
  onInsert: (relPath: string) => void;
}

export default function ImagePickerDialog({ repo, baseDir, open, onClose, onInsert }: Props) {
  const [dir, setDir] = useState(baseDir);
  const [items, setItems] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 每次開啟 dialog → 回到目前編輯檔目錄。
  useEffect(() => {
    if (open) setDir(baseDir);
  }, [open, baseDir]);

  const load = useCallback(
    async (d: string) => {
      setLoading(true);
      setErr(null);
      try {
        const r = await api.tree(repo, d || '.');
        setItems(r.items);
      } catch (e) {
        setItems([]);
        setErr(e instanceof Error ? e.message : '讀取失敗');
      } finally {
        setLoading(false);
      }
    },
    [repo],
  );

  useEffect(() => {
    if (open) void load(dir);
  }, [open, dir, load]);

  const dirs = items.filter((it) => it.type === 'dir');
  const imgs = items.filter((it) => it.type === 'file' && isImageName(it.name));

  const pick = (item: TreeItem) => {
    onInsert(relPath(baseDir, item.path));
    onClose();
  };

  const onUpload = async (files: FileList) => {
    setUploading(true);
    setErr(null);
    try {
      const pics = Array.from(files).filter((f) => f.type.startsWith('image/') || isImageName(f.name));
      for (const f of pics) {
        const name = f.name && isImageName(f.name) ? f.name : `pasted-${stamp()}.png`;
        const b64 = await fileToBase64(f);
        await api.writeFile(repo, joinPath(dir, name), b64, 'base64');
      }
      await load(dir); // 刷新 → 新圖出現
    } catch (e) {
      setErr(e instanceof Error ? e.message : '上傳失敗');
    } finally {
      setUploading(false);
    }
  };

  const crumbs = ['', ...dir.split('/').filter(Boolean)];

  return (
    <Modal
      title="插入圖片"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      data-loc="explore:img:dialog"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button
          size="small"
          icon={<ArrowUpOutlined />}
          disabled={dir === ''}
          onClick={() => setDir(parentOf(dir))}
          title="上一層"
          data-loc="explore:img:up"
        />
        <Breadcrumb
          style={{ flex: 1, minWidth: 0 }}
          items={crumbs.map((_, i) => {
            const path = crumbs.slice(1, i + 1).join('/');
            return {
              title: (
                <a
                  onClick={() => setDir(path)}
                  style={{ cursor: 'pointer' }}
                >
                  {i === 0 ? repo : crumbs[i]}
                </a>
              ),
            };
          })}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void onUpload(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          size="small"
          type="primary"
          icon={<UploadOutlined />}
          loading={uploading}
          onClick={() => fileRef.current?.click()}
          data-loc="explore:img:upload"
        >
          上傳
        </Button>
      </div>

      {err && <div style={{ color: '#cf1322', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : (
        <div style={{ maxHeight: 420, overflow: 'auto' }} data-loc="explore:img:list">
          {/* 子資料夾:點擊鑽入 */}
          {dirs.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {dirs.map((d) => (
                <div
                  key={d.path}
                  onClick={() => setDir(d.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                  data-loc="explore:img:folder"
                >
                  <FolderFilled style={{ color: '#faad14' }} />
                  {d.name}
                </div>
              ))}
            </div>
          )}
          {/* 圖片縮圖:點擊插入 */}
          {imgs.length === 0 ? (
            <Empty description="此目錄無圖片" style={{ margin: '24px 0' }} />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 10,
              }}
            >
              {imgs.map((im) => (
                <div
                  key={im.path}
                  onClick={() => pick(im)}
                  title={`插入 ${im.name}`}
                  style={{
                    border: '1px solid #f0f0f0',
                    borderRadius: 8,
                    padding: 6,
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                  data-loc="explore:img:item"
                  data-path={im.path}
                >
                  <img
                    src={api.rawUrl(repo, im.path)}
                    alt={im.name}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: 90,
                      objectFit: 'contain',
                      background: '#fafafa',
                      borderRadius: 4,
                    }}
                  />
                  <div
                    style={{
                      fontSize: 11,
                      marginTop: 4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {im.name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
