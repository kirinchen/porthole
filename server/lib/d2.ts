/**
 * d2 — 把 `d2` CLI 當 Unix tool 用(SPEC §1 LLM/工具 as Unix tool):
 * stdin(d2 文字)→ stdout(SVG)子程序,**不**在 process 內整合 D2 引擎。
 *
 * d2 是 Go 寫的繪圖語言,原生支援「容器對容器」邊(architecture-beta 做不到)。
 * 渲染走後端 shell out:前端只收 SVG(輕),host 端需有 d2 binary。
 *   - binary 路徑:env `D2_BIN`(預設 'd2',吃 PATH)。見 .env.example。
 *
 * 純文字→文字,不碰 fs,不需 path-guard;但仍是子程序動作面,故:
 *   - 限制輸入大小、加 timeout、argv 不經 shell(避免注入)。
 */
import { spawn } from 'node:child_process';

const D2_BIN = process.env.D2_BIN || 'd2';
const MAX_SRC_BYTES = 256 * 1024; // d2 原始碼上限(防爆)
const RENDER_TIMEOUT_MS = 10_000;

export class D2Error extends Error {}

/**
 * 渲染 d2 文字 → SVG 字串。失敗(編譯錯 / binary 不存在 / timeout)丟 D2Error。
 * 用 `d2 - -`:從 stdin 讀、輸出寫 stdout(不落地任何檔)。
 */
export function renderD2(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof src !== 'string' || !src.trim()) {
      return reject(new D2Error('empty d2 source'));
    }
    if (Buffer.byteLength(src, 'utf8') > MAX_SRC_BYTES) {
      return reject(new D2Error('d2 source too large'));
    }

    let child;
    try {
      // '-' '-' = stdin → stdout。--no-xml-tag 省略 <?xml ...?> 方便直接內嵌。
      child = spawn(D2_BIN, ['--no-xml-tag', '-', '-'], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new D2Error(`spawn d2 failed: ${String(e)}`));
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new D2Error('d2 render timeout')));
    }, RENDER_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.on('error', (e) =>
      finish(() =>
        reject(
          new D2Error(
            (e as NodeJS.ErrnoException).code === 'ENOENT'
              ? `d2 binary not found (D2_BIN=${D2_BIN}); 請安裝 d2 並設定 .env 的 D2_BIN`
              : `d2 process error: ${String(e)}`,
          ),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (code === 0 && out.includes('<svg')) resolve(out);
        else reject(new D2Error(err.trim() || `d2 exited with code ${code}`));
      }),
    );

    child.stdin.on('error', () => {
      /* EPIPE 等 → 交給 close/error 處理 */
    });
    child.stdin.end(src, 'utf8');
  });
}
