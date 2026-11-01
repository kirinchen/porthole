/**
 * HTML 原型「▶ 執行」的隔離規則(SPEC §2)。
 *
 * porthole 同網域上有 /api/:repo/chat(YOLO claude -p)與寫檔 API → repo 裡的 HTML / SVG
 * 絕不能跟 porthole 同源執行。兩道,都靠 code:
 *  1. 回 HTML / SVG 時帶 `Content-Security-Policy: sandbox …`(不給 allow-same-origin)
 *     → 不論是 <iframe> 裡還是直接開網址,文件都是 opaque origin。
 *  2. /api 拒收 opaque origin(`Origin: null`)與跨站(`Sec-Fetch-Site: cross-site`)的請求
 *     → 就算 sandbox 裡的 JS 送出 simple request(不必過 CORS preflight)也打不到 API。
 */

/** 會被瀏覽器當文件執行 script 的副檔名。 */
const ACTIVE_DOC = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);

/** 原型可以跑 JS / alert / 鎖滑鼠;不給 allow-same-origin、allow-top-navigation、allow-forms。 */
export const RUN_SANDBOX = 'sandbox allow-scripts allow-modals allow-pointer-lock';

/**
 * 該帶的 CSP。`run` = /run 執行網址(一律 RUN_SANDBOX);/api/raw 只對會執行的文件加:
 * HTML 給 RUN_SANDBOX,SVG / XML 純 `sandbox`(預覽圖不需要跑 script)。其他(圖片、PDF、媒體)不加
 * —— Chrome 在 sandbox 文件裡不顯示 PDF。
 */
export function sandboxCsp(ext: string, run: boolean): string | null {
  if (run) return RUN_SANDBOX;
  if (!ACTIVE_DOC.has(ext)) return null;
  return ext === '.html' || ext === '.htm' || ext === '.xhtml' ? RUN_SANDBOX : 'sandbox';
}

/** /api 請求來自 sandbox 文件(opaque origin)或別的網站 → 擋。同源 / 無這些 header(curl)放行。 */
export function untrustedApiRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return headers.origin === 'null' || headers['sec-fetch-site'] === 'cross-site';
}
