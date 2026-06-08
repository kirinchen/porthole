/**
 * MermaidBlock — 把一段 mermaid 原始碼渲染成 SVG。
 *  - mermaid 偏重 → 動態 import,只有真的有 mermaid 區塊時才載入。
 *  - securityLevel='strict':渲染 repo 檔 / LLM 回覆內容,擋掉 script / click 注入。
 *  - 若給了 onGuiEdit 且是 flowchart,右上角顯示「GUI 編輯」鈕。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { isFlowchart } from '../lib/mermaidFlow';

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
  onGuiEdit?: (code: string) => void;
}

export default function MermaidBlock({ code, onGuiEdit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
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
  }, [code]);

  if (err) {
    return (
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
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      {onGuiEdit && isFlowchart(code) && (
        <Button
          size="small"
          icon={<EditOutlined />}
          onClick={() => onGuiEdit(code)}
          style={{ position: 'absolute', top: 4, right: 4, zIndex: 2 }}
          data-loc="mermaid:gui-edit"
        >
          GUI 編輯
        </Button>
      )}
      <div ref={ref} style={{ textAlign: 'center' }} />
    </div>
  );
}
