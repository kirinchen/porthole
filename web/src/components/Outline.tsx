/**
 * Outline — markdown 目錄(h1–h6)。工具列一顆按鈕,click 展開 Popover 列出各標題,
 * 點某項 → onJump(該標題在文件中的序號)。序號對應「preview 裡第 N 個 heading 元素」,
 * 由呼叫端負責捲動(見 Explore ExplorePreview.jumpHeading),故不需 heading id / rehype-slug,
 * 也不怕重複標題。
 *
 * 解析與渲染需一致:兩者都跳過 fenced code(``` / ~~~)區塊內的 #,順序才會對齊。
 */
import { useMemo, useState } from 'react';
import { Button, Popover } from 'antd';
import { UnorderedListOutlined } from '@ant-design/icons';

export interface OutlineItem {
  level: number; // 1–6
  text: string; // 已去除 inline markdown 標記的純文字
}

// 去除標題文字裡的 inline markdown(粗體 / 斜體 / 行內 code / 連結),留純文字供顯示。
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/** 解析 ATX 標題(# … ######),跳過 fenced code 區塊。順序 = 文件出現順序。 */
export function parseHeadings(md: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inFence = false;
  let fenceChar = '';
  for (const raw of md.split(/\r?\n/)) {
    const fm = /^\s*(```+|~~~+)/.exec(raw);
    if (fm) {
      const ch = fm[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (hm) out.push({ level: hm[1].length, text: stripInline(hm[2]) });
  }
  return out;
}

export default function Outline({ text, onJump }: { text: string; onJump: (index: number) => void }) {
  const items = useMemo(() => parseHeadings(text), [text]);
  const [open, setOpen] = useState(false);

  const content =
    items.length === 0 ? (
      <div style={{ color: '#999', padding: '4px 8px' }}>此文件沒有標題</div>
    ) : (
      <div
        style={{ maxHeight: 360, overflowY: 'auto', minWidth: 180, maxWidth: 360 }}
        data-loc="explore:outline:list"
      >
        {items.map((h, i) => (
          <div
            key={i}
            onClick={() => {
              onJump(i);
              setOpen(false);
            }}
            title={h.text}
            style={{
              paddingLeft: 4 + (h.level - 1) * 14,
              paddingRight: 8,
              paddingTop: 3,
              paddingBottom: 3,
              cursor: 'pointer',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontSize: h.level <= 2 ? 13 : 12,
              fontWeight: h.level === 1 ? 600 : 400,
              color: h.level === 1 ? undefined : '#555',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f5ff')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            data-loc="explore:outline:item"
          >
            {h.text}
          </div>
        ))}
      </div>
    );

  return (
    <Popover
      content={content}
      title="目錄"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      <Button icon={<UnorderedListOutlined />} title="目錄" data-loc="explore:outline:start" />
    </Popover>
  );
}
