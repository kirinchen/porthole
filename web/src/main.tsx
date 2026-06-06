import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import DevPick from './DevPick';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <App />
      {/* DevPick 掛根層:Ctrl+F12 元素定位器 */}
      <DevPick />
    </ConfigProvider>
  </StrictMode>,
);
