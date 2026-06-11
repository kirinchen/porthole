/**
 * env — 啟動時載入 repo root 的 `.env`(單一設定來源)。
 *
 * 自己解析 KEY=VALUE,不用 `process.loadEnvFile`(該 API 需 Node ≥20.12,
 * 而 systemd 經 nvm 跑的 Node 版本不一定夠新)、也不引 dotenv(薄)。
 *
 * 用 `__dirname` 相對解析,不依賴啟動 cwd。必須在任何「於模組載入期就讀
 * process.env」的模組(如 lib/path-guard 建全域 guard)之前執行 → 故在
 * index.ts 以**首行** import。不覆寫既有 env(外部 env 優先)。
 * 設定項目見 `.env.example`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // server/
const envPath = path.resolve(here, '../.env');

try {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val; // 不覆寫既有 env
  }
} catch {
  /* 無 .env → 沿用外部 env 或程式內預設值 */
}
