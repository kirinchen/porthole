/**
 * MermaidBlock — mermaid 區塊,右上角 tab 切換 預覽 / 編輯 / GUI。
 *  - onApply 有給(Explore)→ 顯示 tab、可寫回;沒給(Chat)→ 純預覽。
 *  - flowchart:預覽 / 編輯 / GUI;其他 mermaid:預覽 / 編輯。
 *  - mermaid 偏重 → 動態 import;FlowEditor(React Flow)→ lazy。
 *  - securityLevel='strict':渲染 repo 檔 / LLM 內容,擋 script / click 注入。
 */
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Segmented, Input, Button, Space, Spin } from 'antd';
import type { SegmentedValue } from 'antd/es/segmented';
import { isFlowchart } from '../lib/mermaidFlow';

const FlowEditor = lazy(() => import('./FlowEditor'));

type Mode = 'preview' | 'edit' | 'gui';

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;
function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const api = m.default as unknown as MermaidApi;
      api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      return api;
    });
  }
  return mermaidPromise;
}

let seq = 0;

interface Props {
  code: string;
  /** 有給 → 可編輯(顯示 tab、套用寫回);沒給 → 純預覽。 */
  onApply?: (newCode: string) => void;
}

export default function MermaidBlock({ code, onApply }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('preview');
  const [draft, setDraft] = useState(code);

  const editable = !!onApply;
  const flow = isFlowchart(code);

  useEffect(() => {
    if (mode !== 'preview') return;
    let alive = true;
    void getMermaid().then(async (mermaid) => {
      try {
        const { svg } = await mermaid.render(`mmd-${seq++}`, code);
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message ?? String(e));
      }
    });
    return () => {
      alive = false;
    };
  }, [code, mode]);

  const opts = [{ label: '預覽', value: 'preview' }];
  if (editable) opts.push({ label: '編輯', value: 'edit' });
  if (editable && flow) opts.push({ label: 'GUI', value: 'gui' });

  const onTab = (v: SegmentedValue) => {
    const m = v as Mode;
    if (m === 'edit') setDraft(code); // 進編輯時以目前內容為準
    setMode(m);
  };

  return (
    <div
      style={{
        border: editable ? '1px solid #f0f0f0' : undefined,
        borderRadius: 8,
        padding: editable ? 8 : 0,
        margin: editable ? '8px 0' : 0,
      }}
    >
      {editable && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <Segmented size="small" value={mode} onChange={onTab} options={opts} data-loc="mermaid:tabs" />
        </div>
      )}

      {mode === 'preview' &&
        (err ? (
          <pre
            style={{
              color: '#cf1322',
              background: '#fff1f0',
              padding: 8,
              borderRadius: 6,
              whiteSpace: 'pre-wrap',
            }}
          >
            mermaid 解析失敗:{err}
            {'\n\n'}
            {code}
          </pre>
        ) : (
          <div ref={ref} style={{ textAlign: 'center' }} />
        ))}

      {mode === 'edit' && (
        <div>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 24 }}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
            data-loc="mermaid:edit"
          />
          <Space style={{ marginTop: 8, width: '100%', justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setMode('preview')}>
              取消
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                onApply?.(draft.trim());
                setMode('preview');
              }}
              data-loc="mermaid:edit:apply"
            >
              套用
            </Button>
          </Space>
        </div>
      )}

      {mode === 'gui' && (
        <Suspense fallback={<Spin />}>
          <FlowEditor
            code={code}
            onSave={(c) => {
              onApply?.(c);
              setMode('preview');
            }}
            onClose={() => setMode('preview')}
          />
        </Suspense>
      )}
    </div>
  );
}
