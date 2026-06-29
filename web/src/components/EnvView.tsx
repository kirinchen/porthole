/**
 * EnvView — `.env` 檔的美化預覽(read-only)。
 *  - 解析 dotenv:註解(#)、空行、KEY=VALUE(含 `export `、單/雙引號)。
 *  - 渲染成 KEY / VALUE 兩欄表;註解獨立分段列;值可一鍵複製、可整體遮罩(env 常含密鑰)。
 *  - 編輯仍走原始 textarea(此元件僅美化顯示,不解析回寫,避免破壞原始格式/註解)。
 */
import { useMemo, useState } from 'react';
import { Typography, Button, Tooltip, Empty } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined, CopyOutlined, CheckOutlined } from '@ant-design/icons';

type Line =
  | { kind: 'comment'; text: string }
  | { kind: 'blank' }
  | { kind: 'pair'; key: string; value: string; exported: boolean }
  | { kind: 'other'; text: string };

const PAIR_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;

/** 去掉一層成對的單/雙引號(僅顯示用)。 */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseEnv(src: string): Line[] {
  return src.replace(/\r\n?/g, '\n').split('\n').map((rawLine): Line => {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) return { kind: 'blank' };
    if (line.trimStart().startsWith('#')) return { kind: 'comment', text: line.trimStart().replace(/^#\s?/, '') };
    const m = PAIR_RE.exec(line);
    if (m) return { kind: 'pair', key: m[2], value: unquote(m[3]), exported: !!m[1] };
    return { kind: 'other', text: line };
  });
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? '已複製' : '複製值'}>
      <Button
        type="text"
        size="small"
        icon={done ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
        data-loc="env:copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      />
    </Tooltip>
  );
}

export default function EnvView({ content }: { content: string }) {
  const lines = useMemo(() => parseEnv(content), [content]);
  const [reveal, setReveal] = useState(true); // 預設顯示值(beautifier 重在好讀);可切遮罩
  const pairCount = lines.filter((l) => l.kind === 'pair').length;

  return (
    <div data-loc="env:view">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          gap: 8,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {pairCount} 個變數
        </Typography.Text>
        <Button
          size="small"
          icon={reveal ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          onClick={() => setReveal((r) => !r)}
          data-loc="env:mask"
        >
          {reveal ? '遮罩值' : '顯示值'}
        </Button>
      </div>

      {pairCount === 0 && !lines.some((l) => l.kind === 'comment') ? (
        <Empty description="空的 .env" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {lines.map((l, i) => {
            if (l.kind === 'blank') return <div key={i} style={{ height: 6 }} />;
            if (l.kind === 'comment') {
              return (
                <div
                  key={i}
                  style={{ color: '#8c8c8c', fontStyle: 'italic', fontSize: 12, padding: '2px 0' }}
                  data-loc="env:comment"
                >
                  {l.text || ' '}
                </div>
              );
            }
            if (l.kind === 'other') {
              return (
                <div key={i} style={{ color: '#cf1322', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                  {l.text}
                </div>
              );
            }
            // pair
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '4px 6px',
                  borderRadius: 6,
                  background: i % 2 ? 'transparent' : '#fafafa',
                }}
                data-loc="env:row"
              >
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontWeight: 600,
                    color: '#1677ff',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    minWidth: 0,
                    maxWidth: '45%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={(l.exported ? 'export ' : '') + l.key}
                >
                  {l.key}
                </span>
                <span style={{ color: '#bbb' }}>=</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 13,
                    wordBreak: 'break-all',
                    color: l.value ? '#262626' : '#bbb',
                  }}
                >
                  {l.value ? (reveal ? l.value : '•'.repeat(Math.min(l.value.length, 24))) : '(空)'}
                </span>
                {l.value && <CopyBtn text={l.value} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
