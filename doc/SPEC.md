# porthole — SPEC(SSoT)

> 舷窗。一個 path-scoped 的 web 介面,讓人透過瀏覽器跟住在各 repo 裡的 agent(主要是 coral 前台助理)高效溝通。
> 取代純 CLI 對話的高溝通成本;參考 Claude Desktop 的左側 Tab 佈局。

本檔是 porthole 的 **Single Source of Truth**。實作以本檔為準;與程式碼衝突時,先改本檔再改 code。

---

## 0. 定位與治理

- **是什麼**:給 coral 前台助理(及各 repo)用的 web GUI。後端是一個 node server,前端是 Vite + React SPA。
- **不是什麼**:不是桌面 app(非 Tauri)、不是 InRay 的分支(僅參考其 UI 殼)、不是通用檔案總管。
- **開發治理(BDA⇄REA)**:見 `doc/Wiki/guides/bda-rea-agent-split.md`。
  - **Kelp = 上層 builder/派工者**:備料、切邊界、驗收、把關 push。
  - **porthole BDA = 實作者**:在 porthole repo root 的 dev session 寫 code。
  - **不自我放行**:對外動作(push / 部署 / 建 remote)先列計畫等 Kirin 拍板;BDA 不自我結案。

---

## 1. 技術選型

| 層 | 選擇 | 備註 |
|----|------|------|
| 前端 | Vite + React 19 + TypeScript(strict) | 抄 InRay UI 殼;files tree / markdown 預覽可移植 |
| UI 元件 | Antd 6 + 自寫 | 跟 InRay 一致 |
| 後端 | 單一 node server,**Fastify** | 同時 serve 前端 build + REST/SSE + WebSocket + path 映射 |
| 終端(CLI/Session) | `node-pty` + `xterm.js` | 真 PTY 才能 tmux attach、互動 console |
| Chat 串流 | spawn `claude -p` → SSE | LLM as Unix tool:stdin→stdout 子程序,不整合 SDK |
| 元素定位 | 移植 `DevPick.tsx`(Ctrl+F12) | 見 `doc/Wiki/guides/dev-pick-locator.md` |

Node 走 nvm 管理。前端 strict TS,`no-explicit-any` 比照 InRay 從嚴。

---

## 2. Port / basePath / 安全(核心,不可妥協)

- 單一 port **4321**。
- **basePath = `/home/kirin/Desktop/project`**(可由 env `PORTHOLE_BASE` 覆寫)。
- URL 第一段 = repo 名:`http://localhost:4321/coral` → `<base>/coral` 頂該 repo root;`/inray` → `<base>/inray`,依此類推。
- **path guard(REA 實體邊界)**:
  - 所有 fs 讀寫、claude/tmux 的 CWD,**一律先正規化(`realpath`)再驗證仍落在 `<base>` 之內**;任何 `..` 逃逸出 base → 直接拒絕(HTTP 403)。
  - 概念抄 InRay `inray-paths` path guard。這是把「web 變全機讀檔漏洞」擋掉的唯一防線,**不靠 prompt,靠 code**。
  - 寫入面收斂:Chat 只能寫 `<repo>/doc/chat/`;其餘寫入逐一在 SPEC 明列才開放。
- **預設綁 `127.0.0.1`(loopback)**。設 `HOST` 環境變數可改綁定位址。
  - **正式部署(本機 kirin-desktop)實際綁 `HOST=0.0.0.0`**,開放 tailscale 連入(網址 **http://100.114.93.81:4321**)。本機家用無公網直連,`0.0.0.0` 實際只開 tailscale + LAN,非全網暴露。部署方式見 `RUN.md`「systemd 常駐」+ `deploy/`。
  - 預設值仍維持 `127.0.0.1`;開放對外屬部署時的顯式決定,由 env 覆寫,不改預設。
  - 注意:tailscale/區網走 **http**(非 https),非 secure context → 瀏覽器 `navigator.clipboard` 失效,複製功能受影響(見 §6)。path guard 仍是唯一實體邊界,不因綁定位址放寬。

---

## 3. 佈局

仿 Claude Desktop:左側窄欄四個 Tab(垂直 icon + label),右側主區。頂部一條 repo 選擇器(決定 active repo root,即 basePath 下哪個 repo)。

```
┌──────────┬─────────────────────────────────┐
│ [repo ▾] │  (主區:隨 active Tab 切換)        │
│  Explore │                                 │
│  Chat    │                                 │
│  Session │                                 │
│  CLI     │                                 │
└──────────┴─────────────────────────────────┘
```

---

## 4. 四個 Tab 規格

### 4.1 Explore
- files tree(抄 InRay `features/repo`),根 = active repo root。
- 點檔案 → 右側預覽(markdown 走 remark/rehype 渲染;其他純文字)。
- 唯讀 MVP;編輯延後。

### 4.2 Chat
- 透過 `claude -p` 跟 active repo 的 agent 對話(coral → coral 前台助理)。
- 子程序:`claude -p "<prompt>"`,CWD = active repo root,stdout 以 **SSE** 串回前端逐字顯示。
- **紀錄持久化**:每個 thread 寫成一個 markdown 檔到 `<repo>/doc/chat/<thread>.md`(human + assistant 輪流,append)。
- 取代 `claude-workbench/plugins/chat`(該方案太難用,porthole 不沿用其機制)。
- thread 列表:讀 `<repo>/doc/chat/*.md`。

### 4.3 Session
- 列出 `claude -r` 可恢復的 session。
- 點某個 session → 對應一個 **tmux session**,讓該 claude session 可在背景持續工作(detach 後仍跑)。
- UI 可 attach 進該 tmux(xterm.js)看即時輸出、可 detach。
- tmux session 命名與生命週期管理(建立 / attach / detach / 列出 / 收掉)在實作前由 BDA 出細部設計,Kelp 驗收。**此 Tab 最複雜、風險最高**。

### 4.4 CLI
- 基本 console:PTY shell,CWD = active repo root。
- `node-pty` + `xterm.js`,WebSocket 雙向。

---

## 5. DevPick(Ctrl+F12)

- 完整移植 `doc/Wiki/guides/dev-pick-locator.md` 的 React 實作。
- 掛 App 根層;Ctrl+F12 開/關,hover 高亮,click 複製混合定位器(route / data-loc / text / tag / css)。
- 剪貼簿 fallback:`navigator.clipboard` 在非安全上下文(http 區網)為 undefined → textarea + `execCommand` fallback。
- 關鍵互動元素逐步補 `data-loc`(命名 `頁面:元件:角色`,如 `chat:composer:send`)。
- 用途:Kirin 在瀏覽器指元素 → 貼給 porthole BDA → BDA 精準對到 source,迭代回饋高效。

---

## 6. 目錄結構

```
porthole/
├── CLAUDE.md              # 開發指引 + 安全邊界 + 不自我放行(Kelp 備料)
├── doc/
│   ├── SPEC.md            # 本檔(SSoT)
│   └── Wiki/guides/       # dev-pick-locator.md + bda-rea-agent-split.md(BDA 必讀)
├── server/                # Fastify:routes(chat/session/cli/fs)+ lib(claude-p/tmux/path-guard)
└── web/                   # Vite React:tabs(Explore/Chat/Session/CLI)+ DevPick.tsx
```

---

## 7. 驗收標準(MVP / B 範圍:四 Tab 骨架)

1. `npm run dev`(或等價)在 localhost:4321 起得來,四個 Tab 都可切換、不報錯。
2. repo 選擇器可切 active repo;basePath 映射正確;path guard 擋得住 `../` 逃逸(要有測試)。
3. Explore 能列 active repo 檔案樹、預覽 markdown。
4. Chat 能跟 `claude -p` 一來一回,並把紀錄寫進 `<repo>/doc/chat/`。
5. Session 能列 `claude -r` session、點一個能對到 tmux 並背景跑(細部設計先過 Kelp)。
6. CLI 能開一個 PTY console、互動可用。
7. DevPick:Ctrl+F12 可 pick 並複製定位器(含 http fallback)。

---

## 8. 非目標(MVP 不做)

- 多使用者 / 認證(單機自用)。
- Explore 線上編輯檔案。
- 任何會動真錢 / 部署 / 改外部系統的動作。

---

## 9. 細設定案(BDA 提案,待 Kelp/Kirin 驗收)

### 9.1 Session tab — claude session 列舉 + tmux 生命週期

- **session 列舉(deterministic-first,不走互動式 `claude -r`)**:claude 把每個 session 存成
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`,`encoded-cwd` = repoRoot 把 `/`、`\` 換成 `-`。
  一個 `.jsonl` = 一個可恢復 session。porthole 讀該目錄列出 id / mtime / 首則 user 訊息當標題。
- **tmux 命名**:`porthole_<repo>_<id8>`,只留 `[A-Za-z0-9_]`(tmux 安全)。前綴 `porthole_` 供列舉/收斂。
- **生命週期**:
  - 建立:`tmux new-session -d -s <name> -c <repoRoot> 'claude --resume <id>'`(背景 detached)。
  - attach:後端用 `node-pty` spawn `tmux attach -t <name>`,接到 WS `/ws/tmux/:name`,前端 xterm.js。
  - detach:前端關閉 WS(切走/關 tab)→ tmux client 退出,**session 仍在背景續跑**(本 tab 的目的)。
  - 收掉:`DELETE /api/tmux/:name`(名稱須符 `porthole_*`)→ `tmux kill-session`。
  - porthole **不自動收** session;由使用者顯式收掉,或機器重開時自然消失。
- **WS 協定**:client→server JSON 控制(`{type:'data'|'resize'}`);server→client 純文字 = pty 輸出。

### 9.2 dev / prod 啟動

- **dev**:`tsx watch` 跑 Fastify(4321,REST/SSE/WS)+ Vite dev(5173,proxy `/api`、`/ws` 到 4321)。
  瀏覽器開 `http://127.0.0.1:5173/<repo>`。
- **prod**:`vite build` → `web/dist`;Fastify serve dist(含 SPA fallback,非 `/api`、`/ws` 回 `index.html`)+ API,單 port 4321。瀏覽器開 `http://127.0.0.1:4321/<repo>`。
- 詳見 `RUN.md`。

### 9.3 Chat thread 檔名與格式

- 檔名:`<repo>/doc/chat/<thread>.md`;`<thread>` 收斂為 `[A-Za-z0-9_-]`(≤64 字),空則 `default`,
  再經 path-guard 二次把關(寫入面只允許 `doc/chat/`)。
- 格式:human / assistant 輪流 append,每段 `## 🧑 Human · <ISO>` / `## 🤖 Assistant · <ISO>` 標頭 + 內容。

---

*porthole 存在的意義:把跟 agent 溝通從「敲 CLI」變成「開一扇窗」。*
