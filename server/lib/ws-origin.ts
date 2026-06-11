/**
 * ws-origin — CSWSH(Cross-Site WebSocket Hijacking)防線。
 *
 * WebSocket 不受同源政策約束、也沒有 CORS preflight;porthole 又無認證,
 * 因此任何跨站網頁都能在使用者瀏覽器內連本機 WS(/ws/cli、/ws/tmux)拿 shell。
 * 綁 127.0.0.1 也擋不住 —— 攻擊載體是使用者自己的瀏覽器。
 *
 * 對策:WS upgrade 時要求 `Origin` 與請求 `Host` 同源。porthole 的 SPA 與 WS
 * 同 port,合法連線的 Origin 必等於 Host;跨站 Origin 對不上 → 擋。
 * 瀏覽器無法偽造 WebSocket 的 Origin header,故此檢查對 CSWSH 是實體邊界。
 *
 * 無 Origin header 者(curl / native ws client)非瀏覽器、非 CSWSH 載體 → 放行。
 */
import type { FastifyRequest } from 'fastify';

/** true = 同源(放行);false = 跨站(擋)。 */
export function isSameOriginWs(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // 非瀏覽器客戶端:不受同源政策約束,非 CSWSH 載體
  let originHost: string;
  try {
    originHost = new URL(origin).host; // host = hostname[:port]
  } catch {
    return false; // Origin 不是合法 URL → 擋
  }
  return originHost === req.headers.host;
}
