/**
 * TableBlock — GFM 表格的 GUI 編輯器(CM6 live-preview 內以 widget 取代表格原始碼)。
 *
 *  - 表格 tab:試算表式 grid，可改 cell、加/刪列與欄、切每欄對齊(左/中/右)。
 *  - 原始碼 tab:直接編 pipe 語法,「套用」解析回 grid。
 *
 * 寫回策略(避免受控 input 因 remount 掉焦 / 遺失游標):
 *  - 打字期間只改「本地 model」,不動文件 → 不觸發 CM6 交易 → widget 不 remount。
 *  - 只在 flush 時機把 model 序列化寫回文件(onApply):widget 失焦、Ctrl/Cmd+S、切到原始碼前。
 *    flush 造成的 remount 發生在焦點已離開之後,故不擾打字。
 *  - Ctrl/Cmd+S 的 keydown 在冒泡到 window(Explore 存檔 listener 讀 draftRef)之前先 flush,
 *    確保存到磁碟的是最新內容。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Button, Input, Tooltip } from 'antd';
import type { SegmentedValue } from 'antd/es/segmented';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  type Align,
  type TableModel,
  parseTable,
  serializeTable,
  tableModelEqual,
  emptyTable,
} from '../lib/mdTable';
import { showLinkTip, parseInlineLink } from '../lib/linkTooltip';

interface Props {
  code: string;
  onApply?: (newCode: string) => void;
}

type Mode = 'grid' | 'raw';

// 對齊循環:無 → 左 → 中 → 右 → 無。
const ALIGN_CYCLE: Align[] = ['none', 'left', 'center', 'right'];
const ALIGN_LABEL: Record<Align, string> = { none: '—', left: 'L', center: 'C', right: 'R' };
const ALIGN_TITLE: Record<Align, string> = { none: '不指定', left: '靠左', center: '置中', right: '靠右' };
const textAlignOf = (a: Align): 'left' | 'center' | 'right' => (a === 'none' ? 'left' : a);

// ---- model 純函式(皆回傳新 model)----
function setCell(m: TableModel, r: number, c: number, v: string): TableModel {
  const rows = m.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row));
  return { ...m, rows };
}
function setHeader(m: TableModel, c: number, v: string): TableModel {
  return { ...m, headers: m.headers.map((h, i) => (i === c ? v : h)) };
}
function setAlign(m: TableModel, c: number, a: Align): TableModel {
  return { ...m, aligns: m.aligns.map((x, i) => (i === c ? a : x)) };
}
function addRow(m: TableModel): TableModel {
  return { ...m, rows: [...m.rows, m.headers.map(() => '')] };
}
function delRow(m: TableModel, r: number): TableModel {
  return { ...m, rows: m.rows.filter((_, i) => i !== r) };
}
function addCol(m: TableModel): TableModel {
  return {
    headers: [...m.headers, `欄位 ${m.headers.length + 1}`],
    aligns: [...m.aligns, 'none'],
    rows: m.rows.map((row) => [...row, '']),
  };
}
function delCol(m: TableModel, c: number): TableModel {
  if (m.headers.length <= 1) return m; // 至少留一欄
  return {
    headers: m.headers.filter((_, i) => i !== c),
    aligns: m.aligns.filter((_, i) => i !== c),
    rows: m.rows.map((row) => row.filter((_, i) => i !== c)),
  };
}

const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const cellHasLink = (v: string) => /\[[^\]]*\]\([^)]*\)/.test(v);

/**
 * CellInput — 資料 cell 的編輯框。以自動長高的 <textarea> 取代單行 <input>:
 *  - 失焦:單行不換行(nowrap)截斷,維持表格緊湊。
 *  - focus:pre-wrap 換行 + 依內容自動長高,完整顯示整段內容(不必橫捲)。
 * 換行由 serializeTable 逸出成 `<br>`,不會破壞 pipe 表格。onChange 只改本地 model
 * (同 <input>,打字期間不 dispatch → widget 不 remount)。
 *
 * 連結縮起:失焦且含 `[t](u)` 時,於 textarea 上疊一層 overlay 顯示「連結已縮起」的文字
 * (只顯示連結文字)。overlay 本體 `pointer-events:none` 讓非連結處點擊穿透回 textarea
 * (精準定位游標、進編輯);只有 `<a>` 開 pointer-events 接 hover → 跳「🔗 編輯連結」tooltip
 * (共用 MarkdownEditor 的 dialog;apply 替換該連結)、點連結則進編輯露出原始碼。
 */
function CellInput({
  value,
  align,
  onChange,
  r,
  c,
}: {
  value: string;
  align: 'left' | 'center' | 'right';
  onChange: (v: string) => void;
  r: number;
  c: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  // focus 時依內容自動長高:先歸零再吃 scrollHeight。
  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    if (focused) autosize();
  }, [value, focused]);
  // 選字後右鍵 → 浮出「🔗 連結」鈕(取代原生選單);套用把選取子字串換成 [text](url)。
  // dialog UI 由祖先 MarkdownEditor 的 Modal 接手(table widget 是其子樹)。
  const onContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) return; // 無選取 → 原生選單
    e.preventDefault();
    const selected = value.slice(start, end);
    const inline = parseInlineLink(selected); // 選取本身已是 [t](u) → 預填
    showLinkTip(e.clientX, e.clientY, {
      text: inline ? inline.text : selected,
      url: inline ? inline.url : '',
      apply: (md) => onChange(value.slice(0, start) + md + value.slice(end)),
    });
  };
  const enterEdit = () => ref.current?.focus();

  // 失焦 overlay:把值渲染成 text + 縮起的連結 <a>(連結文字);hover <a> → 編輯連結 tooltip。
  const showOverlay = !focused && cellHasLink(value);
  const overlayNodes: React.ReactNode[] = [];
  if (showOverlay) {
    LINK_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = LINK_RE.exec(value))) {
      if (m.index > last) overlayNodes.push(value.slice(last, m.index));
      const start = m.index;
      const end = LINK_RE.lastIndex;
      const text = m[1];
      const url = m[2];
      overlayNodes.push(
        <a
          key={`l${key++}`}
          className="ph-cell-link"
          title={url}
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            showLinkTip(
              rect.left,
              rect.bottom + 4,
              { text, url, apply: (md) => onChange(value.slice(0, start) + md + value.slice(end)) },
              '🔗 編輯連結',
            );
          }}
          // 點連結 → 進編輯露出原始碼(overlay 本體 pointer-events:none,故此處自行 focus)。
          onMouseDown={(e) => {
            e.preventDefault();
            enterEdit();
          }}
        >
          {text || url}
        </a>,
      );
      last = end;
    }
    if (last < value.length) overlayNodes.push(value.slice(last));
  }

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onContextMenu={onContextMenu}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (ref.current) ref.current.style.height = ''; // 收回單行高
        }}
        style={{
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          padding: '4px 6px',
          fontSize: 13,
          fontFamily: 'inherit',
          lineHeight: 1.5,
          resize: 'none',
          overflow: 'hidden',
          textAlign: align,
          whiteSpace: focused ? 'pre-wrap' : 'nowrap',
        }}
        data-loc="table:cell"
        data-r={r}
        data-c={c}
      />
      {showOverlay && (
        <div
          className="ph-cell-overlay"
          // pointer-events:none → 非連結處點擊穿透回 textarea(精準定位游標);只 <a> 例外。
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            padding: '4px 6px',
            fontSize: 13,
            fontFamily: 'inherit',
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: align,
            background: '#fff',
            boxSizing: 'border-box',
          }}
          data-loc="table:cell:overlay"
          data-r={r}
          data-c={c}
        >
          {overlayNodes}
        </div>
      )}
    </div>
  );
}

export default function TableBlock({ code, onApply }: Props) {
  const initial = useMemo(() => parseTable(code) ?? emptyTable(), [code]);
  const [model, setModel] = useState<TableModel>(initial);
  const [mode, setMode] = useState<Mode>('grid');
  const [rawDraft, setRawDraft] = useState('');
  const [rawErr, setRawErr] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rawRef = useRef(rawDraft);
  rawRef.current = rawDraft;
  const appliedRef = useRef<TableModel>(initial); // 最近寫回文件的 model(避免重複 / 無謂 reformat)
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  // 把某 model 寫回文件(僅在與上次寫回不同時)。
  const applyModel = (m: TableModel) => {
    if (!onApplyRef.current) return;
    if (tableModelEqual(m, appliedRef.current)) return;
    appliedRef.current = m;
    onApplyRef.current(serializeTable(m));
  };

  // flush:把目前編輯狀態寫回文件(依當前 tab)。回傳是否成功(raw 無法解析 → false)。
  const flush = (): boolean => {
    if (modeRef.current === 'raw') {
      const m = parseTable(rawRef.current);
      if (!m) {
        // 原始碼無法解析 → 顯示錯誤(對齊「套用」鈕行為),不靜默丟棄。
        setRawErr('表格格式無法解析(需 header + `---` 分隔列)');
        return false;
      }
      setRawErr(null);
      applyModel(m);
      return true;
    }
    applyModel(modelRef.current);
    return true;
  };

  // 結構變更(加/刪列欄、對齊)→ 即時寫回。這類是「離散」動作(非逐字打字),不像
  // cell 打字需留在本地避免 remount;即時 apply 可確保就算焦點不在 widget 內、之後 Ctrl+S
  // 也不漏存(flush 靠 widget 焦點,結構變更不能依賴它)。cell/header 文字仍走本地 setModel。
  const applyStructural = (next: TableModel) => {
    // 先同步更新 modelRef:apply 會 dispatch → remount 拆掉仍聚焦的 cell → 同步 focusout →
    // onBlur 再 flush。若 modelRef 還是舊值,該 flush 會用舊 model 再 dispatch(巢狀 update,
    // CM6 禁止)。先把 modelRef 設成 next,使那次 flush 看到 modelRef===appliedRef → 略過。
    modelRef.current = next;
    setModel(next);
    applyModel(next);
  };

  const onTab = (v: SegmentedValue) => {
    const next = v as Mode;
    if (next === mode) return;
    if (next === 'raw') {
      // 進原始碼:以目前 model 生成 pipe 文字(含未寫回的本地編輯),不動文件。
      setRawDraft(serializeTable(modelRef.current));
      setRawErr(null);
      setMode('raw');
    } else {
      // 回 grid:解析原始碼;可解析才切,並寫回。
      const m = parseTable(rawRef.current);
      if (!m) {
        setRawErr('表格格式無法解析(需 header + `---` 分隔列)');
        return;
      }
      setModel(m);
      applyModel(m);
      setRawErr(null);
      setMode('grid');
    }
  };

  // 失焦離開整個 widget → flush。
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const nextFocus = e.relatedTarget as Node | null;
    if (nextFocus && rootRef.current?.contains(nextFocus)) return; // 焦點仍在 widget 內
    flush();
  };

  // Ctrl/Cmd+S:先 flush(冒泡到 window 前),讓 Explore 存檔讀到最新 draftRef。
  // 原始碼無法解析時 flush 失敗 → 擋掉冒泡(stopPropagation)避免 Explore 用舊內容存檔並
  // 報假「已儲存」,並 preventDefault 擋瀏覽器存檔對話框;錯誤已由 flush 內 setRawErr 呈現。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (!flush()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  const ncol = model.headers.length;

  return (
    <div
      ref={rootRef}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 8, margin: '8px 0' }}
      data-loc="table:block"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: '#999', fontSize: 12 }}>表格</span>
        <Segmented
          size="small"
          value={mode}
          onChange={onTab}
          options={[
            { label: '表格', value: 'grid' },
            { label: '原始碼', value: 'raw' },
          ]}
          data-loc="table:tabs"
        />
      </div>

      {mode === 'grid' ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }} data-loc="table:grid">
            <thead>
              <tr>
                {model.headers.map((h, c) => (
                  <th
                    key={c}
                    style={{ border: '1px solid #e8e8e8', background: '#fafafa', padding: 0, minWidth: 90 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 4px' }}>
                      <Tooltip title={`對齊:${ALIGN_TITLE[model.aligns[c]]}(點擊切換)`}>
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            const cur = model.aligns[c];
                            const nextA = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(cur) + 1) % ALIGN_CYCLE.length];
                            applyStructural(setAlign(model, c, nextA));
                          }}
                          style={{
                            width: 20,
                            height: 20,
                            border: '1px solid #d9d9d9',
                            borderRadius: 4,
                            background: '#fff',
                            cursor: 'pointer',
                            fontSize: 11,
                            lineHeight: '18px',
                            padding: 0,
                            color: '#555',
                          }}
                          data-loc="table:align"
                          data-c={c}
                        >
                          {ALIGN_LABEL[model.aligns[c]]}
                        </button>
                      </Tooltip>
                      <Tooltip title="刪除此欄">
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => applyStructural(delCol(model, c))}
                          disabled={ncol <= 1}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: ncol <= 1 ? 'not-allowed' : 'pointer',
                            color: ncol <= 1 ? '#ccc' : '#bbb',
                            padding: 0,
                            lineHeight: 1,
                          }}
                          data-loc="table:delcol"
                          data-c={c}
                        >
                          <DeleteOutlined style={{ fontSize: 11 }} />
                        </button>
                      </Tooltip>
                    </div>
                    <input
                      value={h}
                      onChange={(e) => setModel(setHeader(model, c, e.target.value))}
                      placeholder={`欄位 ${c + 1}`}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        padding: '4px 6px',
                        fontWeight: 600,
                        fontSize: 13,
                        textAlign: textAlignOf(model.aligns[c]),
                      }}
                      data-loc="table:header"
                      data-c={c}
                    />
                  </th>
                ))}
                <th style={{ border: 'none', padding: '0 4px', verticalAlign: 'middle', width: 1, whiteSpace: 'nowrap' }}>
                  <Tooltip title="新增欄">
                    <Button
                      size="small"
                      type="text"
                      icon={<PlusOutlined />}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyStructural(addCol(model))}
                      data-loc="table:addcol"
                    />
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      style={{ border: '1px solid #e8e8e8', padding: 0, minWidth: 90, verticalAlign: 'top' }}
                    >
                      <CellInput
                        value={cell}
                        align={textAlignOf(model.aligns[c])}
                        onChange={(v) => setModel(setCell(model, r, c, v))}
                        r={r}
                        c={c}
                      />
                    </td>
                  ))}
                  <td style={{ border: 'none', padding: '0 4px', width: 1, whiteSpace: 'nowrap' }}>
                    <Tooltip title="刪除此列">
                      <Button
                        size="small"
                        type="text"
                        icon={<DeleteOutlined />}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyStructural(delRow(model, r))}
                        data-loc="table:delrow"
                        data-r={r}
                      />
                    </Tooltip>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={ncol + 1} style={{ border: 'none', paddingTop: 4 }}>
                  <Button
                    size="small"
                    type="dashed"
                    icon={<PlusOutlined />}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyStructural(addRow(model))}
                    data-loc="table:addrow"
                  >
                    新增列
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <Input.TextArea
            value={rawDraft}
            onChange={(e) => setRawDraft(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 20 }}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
            data-loc="table:raw"
          />
          {rawErr && <div style={{ color: '#cf1322', fontSize: 12, marginTop: 4 }}>{rawErr}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                const m = parseTable(rawDraft);
                if (!m) {
                  setRawErr('表格格式無法解析(需 header + `---` 分隔列)');
                  return;
                }
                setModel(m);
                applyModel(m);
                setRawErr(null);
                setMode('grid');
              }}
              data-loc="table:raw:apply"
            >
              套用
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
