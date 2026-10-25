import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev:vite(5173)proxy /api 到 Fastify(4321)。prod:Fastify serve dist。
// (/ws 的 proxy 隨 CLI / Session 退場一併移除 —— 已沒有 WebSocket 路由。)
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
