/**
 * MermaidBlock — mermaid 區塊,右上角 tab 切換 預覽 / 編輯 / GUI。
 *  - onApply 有給(Explore)→ 顯示 tab、可寫回;沒給(Chat)→ 純預覽。
 *  - flowchart:預覽 / 編輯 / GUI;其他 mermaid:預覽 / 編輯。
 *  - mermaid 偏重 → 動態 import;FlowEditor(React Flow)→ lazy。
 *  - securityLevel='strict':渲染 repo 檔 / LLM 內容,擋 script / click 注入。
 */
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Segmented, Input, Button, Space, Spin, Switch } from 'antd';
import { FullscreenOutlined } from '@ant-design/icons';
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
  const [guiFull, setGuiFull] = useState(false); // GUI 全螢幕(滿版覆蓋視窗)

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
    if (m !== 'gui') setGuiFull(false); // 離開 GUI → 取消全螢幕
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {mode === 'gui' && (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              data-loc="mermaid:gui:full"
            >
              <FullscreenOutlined style={{ color: '#888' }} />
              <Switch
                size="small"
                checked={guiFull}
                onChange={setGuiFull}
                title="全螢幕"
                data-loc="mermaid:gui:full:switch"
              />
            </span>
          )}
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

      {mode === 'gui' &&
        (() => {
          const editor = (
            <Suspense fallback={<Spin />}>
              <FlowEditor
                code={code}
                fill={guiFull}
                onSave={(c) => {
                  onApply?.(c);
                  setGuiFull(false);
                  setMode('preview');
                }}
                onClose={() => {
                  setGuiFull(false);
                  setMode('preview');
                }}
              />
            </Suspense>
          );
          if (!guiFull) return editor;
          return (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                background: '#fff',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
              }}
              data-loc="mermaid:gui:overlay"
            >
              <div
                style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginBottom: 8 }}
              >
                <FullscreenOutlined style={{ color: '#888' }} />
                <Switch size="small" checked={guiFull} onChange={setGuiFull} title="退出全螢幕" />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>{editor}</div>
            </div>
          );
        })()}
    </div>
  );
}
