/**
 * MermaidBlock — mermaid 區塊,右上角 tab 切換 預覽 / 編輯 / GUI。
 *  - onApply 有給(Explore)→ 顯示 tab、可寫回;沒給(Chat)→ 純預覽。
 *  - flowchart:預覽 / 編輯 / GUI;其他 mermaid:預覽 / 編輯。
 *  - mermaid 偏重 → 動態 import;FlowEditor(React Flow)→ lazy。
 *  - securityLevel='strict':渲染 repo 檔 / LLM 內容,擋 script / click 注入。
 *  - expandable(Markdown 預覽 / Chat):行內只放圖、不放 tab;**點圖 → 全螢幕**,
 *    全螢幕裡才有 預覽 / 編輯 / GUI(有 onApply 時),Esc 或 × 關閉。
 */
import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Segmented, Input, Button, Space, Spin, Switch } from 'antd';
import { CloseOutlined, FullscreenOutlined } from '@ant-design/icons';
import type { SegmentedValue } from 'antd/es/segmented';
import { markKeepGui, takeKeepGui } from '../lib/guiSession';
import { isFlowchart } from '../lib/mermaidFlow';
import { isStateDiagram } from '../lib/mermaidState';
import { isErd } from '../lib/mermaidErd';
import { isClassDiagram } from '../lib/mermaidClass';
import { isSequence } from '../lib/mermaidSequence';
import { isArchitecture } from '../lib/mermaidArchitecture';
import { isMindmap } from '../lib/mermaidMindmap';

const FlowEditor = lazy(() => import('./FlowEditor'));
const StateEditor = lazy(() => import('./StateEditor'));
const ErdEditor = lazy(() => import('./ErdEditor'));
const ClassEditor = lazy(() => import('./ClassEditor'));
const SequenceEditor = lazy(() => import('./SequenceEditor'));
const ArchitectureEditor = lazy(() => import('./ArchitectureEditor'));
const MindmapEditor = lazy(() => import('./MindmapEditor'));

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
      // theme:'dark' —— porthole 本身深色底(SPEC §3.1),用 'default' 會在深色頁面裡爆出一塊白圖。
      api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
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
  /** 跨 remount 保留 GUI 狀態的鍵(由 CM6 widget 傳入 lang:index);Chat 預覽不給。 */
  sessionKey?: string;
  /** 行內只顯示圖,點了開全螢幕(tab 移到全螢幕裡)。Markdown 預覽用。 */
  expandable?: boolean;
}

export default function MermaidBlock({ code, onApply, sessionKey, expandable }: Props) {
  // remount 後若有 keep 標記 → 直接回 GUI(及全螢幕),支援「Ctrl+S 存檔但留在編輯器」。
  const restored = useMemo(() => takeKeepGui(sessionKey), [sessionKey]);
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(restored ? 'gui' : 'preview');
  // expandable:全螢幕開著。存檔後不會掉:Markdown 的 MdCode 是穩定元件,本元件不 remount。
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(code);
  const [guiFull, setGuiFull] = useState(restored?.full ?? false); // GUI 全螢幕(滿版覆蓋視窗)
  // 全螢幕(expandable)裡 GUI 一律滿版;行內的 GUI 才看 guiFull 開關。
  const fill = expanded || guiFull;

  const editable = !!onApply;
  // GUI 可編輯的圖型(互斥,依標頭判定)
  const guiKind: 'flow' | 'state' | 'erd' | 'class' | 'sequence' | 'arch' | 'mindmap' | null = isFlowchart(code)
    ? 'flow'
    : isStateDiagram(code)
      ? 'state'
      : isErd(code)
        ? 'erd'
        : isClassDiagram(code)
          ? 'class'
          : isSequence(code)
            ? 'sequence'
            : isArchitecture(code)
              ? 'arch'
              : isMindmap(code)
                ? 'mindmap'
                : null;

  useEffect(() => {
    if (mode !== 'preview' && !expandable) return;
    let alive = true;
    void getMermaid().then(async (mermaid) => {
      try {
        const { svg } = await mermaid.render(`mmd-${seq++}`, code);
        if (alive) {
          setSvg(svg);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message ?? String(e));
      }
    });
    return () => {
      alive = false;
    };
  }, [code, mode, expandable]);

  const opts = [{ label: '預覽', value: 'preview' }];
  if (editable) opts.push({ label: '編輯', value: 'edit' });
  if (editable && guiKind) opts.push({ label: 'GUI', value: 'gui' });

  const onTab = (v: SegmentedValue) => {
    const m = v as Mode;
    if (m === 'gui' && !guiKind) return; // 無對應 GUI 編輯器時不進 gui(防呆)
    if (m === 'edit') setDraft(code); // 進編輯時以目前內容為準
    if (m !== 'gui') setGuiFull(false); // 離開 GUI → 取消全螢幕
    setMode(m);
  };

  const closeExpanded = () => {
    setExpanded(false);
    setMode('preview');
  };
  // Esc 關全螢幕 —— 只在預覽時(編輯 / GUI 裡 Esc 可能是編輯器自己要的,不搶)。
  useEffect(() => {
    if (!expanded || mode !== 'preview') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeExpanded();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, mode]);

  const errBox = (
    <pre
      style={{
        color: 'var(--danger)',
        background: 'rgba(226,114,91,0.12)',
        padding: 8,
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
      }}
    >
      mermaid 解析失敗:{err}
      {'\n\n'}
      {code}
    </pre>
  );

  // 行內(expandable):只放圖,點了開全螢幕。
  if (expandable && !expanded) {
    return err ? (
      errBox
    ) : (
      <div
        className="ph-mmd-inline"
        onClick={() => setExpanded(true)}
        title={editable ? '點擊全螢幕(可切換編輯)' : '點擊全螢幕'}
        style={{ textAlign: 'center', cursor: 'zoom-in' }}
        data-loc="mermaid:expand"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  const boxed = editable && !expanded;
  const body = (
    <div
      style={
        expanded
          ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }
          : {
              border: boxed ? '1px solid var(--line)' : undefined,
              borderRadius: 8,
              padding: boxed ? 8 : 0,
              margin: boxed ? '8px 0' : 0,
            }
      }
    >
      {editable && !expanded && (
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
          errBox
        ) : (
          <div
            className={expanded ? 'ph-mmd-full' : undefined}
            style={{ textAlign: 'center', ...(expanded ? { flex: 1, minHeight: 0 } : {}) }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ))}

      {mode === 'edit' && (
        <div>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={expanded ? { minRows: 20 } : { minRows: 4, maxRows: 24 }}
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
          const EditorComp =
            guiKind === 'state'
              ? StateEditor
              : guiKind === 'erd'
                ? ErdEditor
                : guiKind === 'class'
                  ? ClassEditor
                  : guiKind === 'sequence'
                    ? SequenceEditor
                    : guiKind === 'arch'
                      ? ArchitectureEditor
                      : guiKind === 'mindmap'
                        ? MindmapEditor
                        : FlowEditor;
          const editor = (
            <Suspense fallback={<Spin />}>
              <EditorComp
                code={code}
                fill={fill}
                onSave={(c, opts) => {
                  // stay(Ctrl+S / 儲存):寫回但留在 GUI。改寫文件會使本元件 remount,
                  // 故先標記 sessionKey,讓 remount 後的新元件直接回到 GUI(及全螢幕)。
                  if (opts?.stay) {
                    if (sessionKey) markKeepGui(sessionKey, guiFull);
                    onApply?.(c);
                    // 觸發 Explore 存檔到磁碟(不退出編輯)。onApply 已同步更新 draft。
                    if (sessionKey) window.dispatchEvent(new Event('porthole:save-file'));
                  } else {
                    onApply?.(c);
                    setGuiFull(false);
                    setMode('preview');
                  }
                }}
                onClose={() => {
                  setGuiFull(false);
                  setMode('preview');
                }}
              />
            </Suspense>
          );
          if (!guiFull || expanded) return editor; // 全螢幕(expandable)本身已滿版
          // portal 到 body:脫離 CM6/編輯器祖先的 containing block,fixed 才能真正
          // 覆蓋整個視窗(否則只蓋中央、右側 Chat 仍露出)。z-index 低於 antd modal(1000)
          // 以便 FlowEditor 的節點/邊編輯視窗仍在最上層。
          return createPortal(
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 900,
                background: 'var(--surface)',
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
            </div>,
            document.body,
          );
        })()}
    </div>
  );

  if (!expanded) return body;
  // 全螢幕:portal 到 body(同 GUI 全螢幕,脫離預覽區 / CM6 的 containing block)。
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'var(--surface)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
      }}
      data-loc="mermaid:full"
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {opts.length > 1 && (
          <Segmented size="small" value={mode} onChange={onTab} options={opts} data-loc="mermaid:tabs" />
        )}
        <Button size="small" icon={<CloseOutlined />} onClick={closeExpanded} title="關閉(Esc)" data-loc="mermaid:full:close" />
      </div>
      {body}
    </div>,
    document.body,
  );
}
