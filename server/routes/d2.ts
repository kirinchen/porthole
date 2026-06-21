/**
 * d2 route — D2 圖型渲染。
 * POST /api/d2/render  body {src}  → {svg}   (d2 文字 → SVG,shell out d2 CLI)
 *
 * 純文字→文字,不碰 fs(無 repo / path 參數)。編譯錯回 422 + 錯誤訊息,
 * 讓前端在預覽區顯示。binary 不存在 / timeout → 500。
 */
import type { FastifyInstance } from 'fastify';
import { renderD2, D2Error } from '../lib/d2.ts';

export default async function d2Routes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { src?: string } }>('/api/d2/render', async (req, reply) => {
    const src = req.body?.src;
    if (typeof src !== 'string') {
      return reply.code(400).send({ error: 'missing src' });
    }
    try {
      const svg = await renderD2(src);
      return reply.send({ svg });
    } catch (e) {
      if (e instanceof D2Error) {
        // 編譯錯(使用者 d2 語法問題)→ 422;binary/timeout 等執行面 → 500。
        const isCompile = !/not found|timeout|spawn/.test(e.message);
        return reply.code(isCompile ? 422 : 500).send({ error: e.message });
      }
      throw e;
    }
  });
}
