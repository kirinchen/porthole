import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import DevPick from './DevPick';
import ContentPick from './components/ContentPick';
import './styles.css';

// 部署後 chunk 換新 hash,舊分頁的 lazy import(MarkdownEditor / mermaid 編輯器等)會 404。
// 偵測到動態載入失敗 → 重整抓最新 index.html(server 已對 index.html no-cache)。
// 守衛:同分頁短時間內最多重整一次(防真壞時無限轉);健康跑一陣子後解除,
// 讓長壽分頁在未來新部署仍能自動復原。
const RELOAD_KEY = 'ph-chunk-reloaded';
function recoverFromStaleChunk() {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return; // 本分頁剛重整過仍失敗 → 不再轉,避免無限迴圈
    sessionStorage.setItem(RELOAD_KEY, '1');
  } catch {
    /* sessionStorage 不可用 → 略過守衛,直接重整 */
  }
  window.location.reload();
}
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  recoverFromStaleChunk();
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && (e.reason.message ?? e.reason)) || '');
  if (/dynamically imported module|module script failed|Failed to fetch/i.test(msg)) {
    recoverFromStaleChunk();
  }
});
// 健康跑滿 10s → 解除守衛,使日後新部署的失效 chunk 仍能觸發自動復原。
setTimeout(() => {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* 略過 */
  }
}, 10000);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <App />
      {/* DevPick 掛根層:Ctrl+F12 元素定位器 */}
      <DevPick />
      {/* ContentPick:挑內容帶進 Chat 對話(由 Chat 的「引用內容」鈕啟動) */}
      <ContentPick />
    </ConfigProvider>
  </StrictMode>,
);
