import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import DevPick from './DevPick';
import ContentPick from './components/ContentPick';
import './styles.css';

// 部署後 chunk 換新 hash,舊分頁的 lazy import(MarkdownEditor / mermaid 等)會 404。
// Vite 在動態載入失敗時派發 vite:preloadError → 重整一次抓最新 index.html 即可復原。
let reloadedOnce = false;
window.addEventListener('vite:preloadError', () => {
  if (reloadedOnce) return; // 防無限重整
  reloadedOnce = true;
  window.location.reload();
});

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
