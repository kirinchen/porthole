import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev:vite(5173)proxy /api、/ws 到 Fastify(4321)。prod:Fastify serve dist。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4321', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
