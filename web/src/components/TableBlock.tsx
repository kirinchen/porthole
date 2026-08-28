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
import { useMemo, useRef, useState } from 'react';
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
                    <td key={c} style={{ border: '1px solid #e8e8e8', padding: 0, minWidth: 90 }}>
                      <input
                        value={cell}
                        onChange={(e) => setModel(setCell(model, r, c, e.target.value))}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          border: 'none',
                          outline: 'none',
                          background: 'transparent',
                          padding: '4px 6px',
                          fontSize: 13,
                          textAlign: textAlignOf(model.aligns[c]),
                        }}
                        data-loc="table:cell"
                        data-r={r}
                        data-c={c}
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
