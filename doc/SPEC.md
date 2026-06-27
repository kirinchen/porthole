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
- **basePath = `<your-project-base>`**(原始碼內 `DEFAULT_BASE`,可由 env `PORTHOLE_BASE` 覆寫)。
- URL 第一段 = repo 名:`http://localhost:4321/coral` → `<base>/coral` 頂該 repo root;`/inray` → `<base>/inray`,依此類推。
- **path guard(REA 實體邊界)**:
  - 所有 fs 讀寫、claude/tmux 的 CWD,**一律先正規化(`realpath`)再驗證仍落在 `<base>` 之內**;任何 `..` 逃逸出 base → 直接拒絕(HTTP 403)。
  - 概念抄 InRay `inray-paths` path guard。這是把「web 變全機讀檔漏洞」擋掉的唯一防線(**僅就 fs 讀寫而言**,見下方適用範圍),**不靠 prompt,靠 code**。
  - 寫入面收斂(逐一明列才開放):
    - Chat:只能寫 `<repo>/doc/chat/`。
    - Explore 編輯:可寫 active repo 內**任一路徑**(覆寫既存或新增),仍受 path-guard 鎖在 repo root 內、逃不出 base。`PUT /api/:repo/file`。(注意:repo 內含 `.git/`、`.claude/` 等 dotfile 也在可寫範圍 → 寫 git hook 可間接執行;這在「單機自用 + 信任網路」前提下接受。)
- **⚠️ 邊界的適用範圍(誠實聲明,別誤判)**:path guard 只約束 **fs 讀寫與子程序的 CWD**。**CLI / Session tab 是完整 PTY**(shell / `tmux attach`)——使用者可在其中 `cd` 到任何地方、執行任意指令,等同**以服務執行身分的完整 RCE**;path guard 對此**不是限制**(只決定起始目錄)。porthole **無認證**(§8,單機自用),所以 CLI/Session 的安全**完全靠「只在信任網路內、無未授權者可達」這個營運假設**撐著。對外開放 = 把一個 shell 開給該網段所有人。
- **CSWSH 防線(WS 同源檢查)**:WebSocket 不受同源政策約束、無 CORS preflight,任何跨站網頁可在使用者瀏覽器內連本機 WS(`/ws/cli`、`/ws/tmux`)拿 shell —— **綁 `127.0.0.1` 也擋不住**,因為攻擊載體是使用者自己的瀏覽器。對策:WS upgrade 要求 `Origin` 與請求 `Host` 同源,跨站一律拒(`server/lib/ws-origin.ts`)。瀏覽器無法偽造 WebSocket Origin,故此檢查對 CSWSH 是實體邊界;非瀏覽器(無 Origin)放行。
- **預設綁 `127.0.0.1`(loopback)**。綁定由 repo root 的 `.env` 之 `HOST` 決定(`server/env.ts` 載入;設定範本 `.env.example`)。
  - **正式部署綁 tailscale 網卡 IP**(網址 **http://<your-tailscale-ip>:4321**)→ **只 tailnet 可達**,不開 LAN、也不綁 loopback。等於用 **tailnet 成員身分當網路層認證**,收掉 LAN 破口。本機開瀏覽器也走 tailscale 網址。部署見 `RUN.md`「systemd 常駐」+ `deploy/`。
  - **不要綁 `0.0.0.0`**:那會連 LAN 整段一起開;porthole 無認證、CLI=RCE(見下),只在完全信任的網路才可。預設值仍維持 `127.0.0.1`,放寬綁定屬部署時的顯式決定(改 `.env`,不改 code 預設)。
  - 注意:tailscale/區網走 **http**(非 https),非 secure context → 瀏覽器 `navigator.clipboard` 失效,複製功能受影響(見 §6)。path guard 仍是 fs 面的實體邊界,不因綁定位址放寬(但它不約束 CLI/Session 的 PTY,見上方適用範圍)。

---

## 3. 佈局

**桌面(≥md)= Obsidian/VSCode 式三欄**。頂部一條 repo 選擇器(決定 active repo root)。
Explore(檔案樹 + 預覽/編輯)固定占左+中工作區、恆亮;右側面板以 tab 切
Chat / Session / CLI,**保活不卸載**(切走不斷 session 終端 WS)。中央/右側交界用
可拖動 Splitter 調寬窄,右側可收合。目的:**邊編輯檔案邊與 session 對話**。

```
┌──────────────────────────────────────────────────────────┐
│ [repo ▾]   porthole · 舷窗                                  │
├──────────────┬───────────────────────────┬───────────────┤
│ explore:tree │  explore:preview          │ [Chat|Session │
│  檔案樹       │  檔案預覽 / 編輯(恆在中央)│  |CLI] 切換    │
│  (左)        │            ←  拖  →        │  保活、可收合  │
└──────────────┴───────────────────────────┴───────────────┘
```

**手機(<md)= 單窗格**:三欄塞不下 → 退回左側窄欄四-Tab(Explore/Chat/Session/CLI)
單選切換(舊 Claude Desktop 式),檔案樹於 Explore 內收進 Drawer。

- **URL 狀態**:repo 走 pathname 第一段(`/coral`),active tab 走 hash(`/coral#chat`)。
  桌面 hash 決定右側面板選哪個(Explore 恆亮,故 hash=explore 時右側預設 Chat);
  手機 hash 決定單窗格顯示哪個。reload / bookmark / 上一頁皆可還原;hash 純前端,server 不參與。

---

## 4. 四個 Tab 規格

### 4.1 Explore
- files tree(抄 InRay `features/repo`),根 = active repo root。
- 點檔案 → 右側預覽(markdown 走 remark/rehype 渲染;圖片(png/jpg/gif/webp/svg/bmp/ico/avif)以 `<img>` 顯示,來源 `GET /api/:repo/raw`(path-guard、依副檔名給 content-type);其他純文字)。
- 點**資料夾** → 中央顯示該夾內容 grid(可點:檔案開檔、子夾鑽入)+ 其 `README.md`(若有,case-insensitive)渲染於下。
- **編輯**:預覽區「編輯」鈕 → markdown 走 CM6 Obsidian 式 live-preview、其他純 textarea → 儲存(`PUT /api/:repo/file`)。「儲存」鈕存檔並回預覽;**Ctrl/Cmd+S** 存檔但**不離開編輯**(派 `porthole:save-file`,讀 draftRef)。
- **@/# 自動完成**(CM6 編輯):打 `@` 選檔(以**目前編輯檔目錄**為基準、lazy 逐層、資料夾續查、`../` 往上夾在 repo root)、`#` 選章節(`@file#` 取該檔標題 / 單獨 `#` 取目前檔標題),可混用 `@abc.md#chat1`(`lib/mentionComplete`)。
- **新增**:檔案樹「新檔」鈕 → 輸入相對路徑(中間目錄自動建立)→ 編輯後儲存。
- 寫入受 path-guard 鎖在 active repo root 內(見 §2 寫入面)。
- **mermaid**:
  - **預覽**:純渲染 ```mermaid 圖(securityLevel=strict),不帶編輯控制(預覽即看)。
  - **編輯(CM6)**:每個 ```mermaid block 換成互動 box,右上 tab 切 **預覽 / 編輯 / GUI**;
    **flowchart / stateDiagram / erDiagram / classDiagram / sequenceDiagram / architecture-beta / mindmap 有 GUI tab**(各對應專屬編輯器),其餘只有 預覽 / 編輯。
    套用直接改寫 CM6 文件對應區塊,隨檔案一起存。空白行右鍵選單可一鍵插入各圖型範例(GUI 可編輯)。
  - GUI 編輯器(節點圖型用 React Flow + dagre,共用:雙擊改字、拖把手連線、Delete 刪、新增、復原/重做、複製/貼上、全螢幕;「套用」正規化重寫並回 preview;**Ctrl+S / 儲存** = 存檔寫回磁碟但**留在編輯器**,跨 widget remount 以 sessionKey 保留 GUI 狀態):
    - **flowchart**(`mermaidFlow` + `FlowEditor`):矩形/圓角/菱形節點 + 有向邊 + 邊標籤 + 方向。
    - **state diagram**(`mermaidState` + `StateEditor`):狀態 + 起點/終點([*]) + 轉移標籤 + 方向。
    - **ERD**(`mermaidErd` + `ErdEditor`):實體(屬性 type/name/PK/FK/UK/註解)+ 關係(左右 cardinality + 識別/非識別 + 標籤)。
    - **class**(`mermaidClass` + `ClassEditor`):類別(stereotype + 成員 visibility/attr/method)+ 關係(繼承/組合/聚合/關聯/依賴/實現 + multiplicity + 標籤)。
    - **sequence**(`mermaidSequence` + `SequenceEditor`,**清單式表單非畫布**):participant/actor(alias)+ 有序訊息(8 種箭頭 + activation)。
    - **architecture**(`mermaidArchitecture` + `ArchitectureEditor`):group(可巢狀)+ service(icon/title)+ junction + 邊(L/R/T/B 側接點 + 箭頭方向 + group 端點)。
    - **mindmap**(`mermaidMindmap` + `MindmapEditor`):縮排式樹(單 root 不變式)+ 節點形狀(預設/方/圓角/圓/六角/雲/爆炸)+ icon/class;階層用邊表達,拖把手連線=改 parent(防環/防多 root),新增子/兄弟、刪子樹。
    - 各圖型只支援其子集;subgraph / composite state / loop/alt 等超出子集者退回純文字編輯。
  - mermaid / React Flow 皆 lazy-load,不進主 bundle。
- **連結內部導航**(CM6 live-preview):點 markdown 連結 → 外部(他站 / mailto)新分頁;站內(相對含 `..` / 絕對 `/<repo>/<path>` / 本站完整 URL)→ 開檔(中央預覽 + 樹逐層展開反白)或資料夾(展開反白不開檔),tab 跟連結 `#tab`(explore/chat/session/cli)。URL 雙向 deep-link:`/<repo>/<file_path>#<tab>` 載入即開、開檔即同步網址。`lib/pathLink` 解析 + `porthole:navigate` 事件(App 切 repo/tab、Explore 開檔/展開)。
  - **動機**:D2 容器是一等公民,原生支援「**容器對容器**」邊(mermaid architecture-beta 做不到——其 group 不能當邊端點)。
  - **渲染**:走後端 shell out `d2` CLI(SPEC §1「as Unix tool」):`POST /api/d2/render {src}` → stdin→stdout 取 SVG;前端只收 SVG(輕)。binary 路徑由 `.env` 的 `D2_BIN` 設定(預設 `d2`,吃 PATH);未安裝不影響其他功能。SVG 注入前淨化(去 script / on* / 危險協定連結)。
  - **編輯**:每個 ```d2 block 換成互動 box(預覽 / 編輯 / GUI),與 mermaid 共用 CM6 widget 機制(`FenceWidget`,每語言各自計數);套用直接改寫文件。
  - **GUI 編輯器**(`lib/d2` + `D2Editor`,React Flow + dagre):container(可巢狀,可當邊端點)+ shape + 邊(4 種箭頭 + label);container 與 shape 四邊皆有接點。擋 D2 layout 非法邊(自連、container↔後代/祖先)。序列化 id 自動處理 D2 保留字 / 特殊字元引號。
  - 子集:style/class/sql_table/icon/near 等進階語法退回純文字編輯。

### 4.2 Chat
- 透過 `claude -p` 跟 active repo 的 agent 對話(coral → coral 前台助理)。
- 子程序:`claude -p "<prompt>"`,CWD = active repo root,stdout 以 **SSE** 串回前端逐字顯示。
- **對話記憶**:`claude -p` 每次是 stateless 一次性呼叫,故送出前把該 thread 先前的對話紀錄(turn markdown)當 context 接在最新訊息前一起餵入(尾端取最近 ~120KB),agent 才有上下文。
- **紀錄持久化**:每個 thread 寫成一個 markdown 檔到 `<repo>/doc/chat/<thread>.md`(human + assistant 輪流,append)。
- **首輪自動命名**:新 thread 預設 `thread-<ts>`;第一輪回覆完成後,後端 `POST .../threads/:thread/rename` 用 `claude -p` 分析對話主題產生英文 kebab-case slug,在 `doc/chat/` 內 `fs.rename`(path-guard + 衝突加 `-N`)。生不出或同名則維持原名。
- **手動改名**:topbar 改名鈕(`chat:rename`)→ 同 rename 端點帶 `{to}`(safeThread 收斂)`fs.rename`;空 thread(尚無檔)則本地改名,下次訊息寫新檔。
- 取代 `claude-workbench/plugins/chat`(該方案太難用,porthole 不沿用其機制)。
- thread 列表:讀 `<repo>/doc/chat/*.md`。
- agent 回覆中的 ```mermaid 區塊同樣渲染成圖(共用 Explore 的 Markdown 元件;Chat 僅呈現,不提供 GUI 編輯)。
- **composer @ mention 檔案**:輸入框打 `@` 觸發檔案 hint 下拉(`data-loc="chat:composer:mention"`)。
  - 選資料夾續查下一層、`../` 回上層;鍵盤 ↑↓ 選、Enter/Tab 選中、Esc 關(下拉關閉時 Enter 才送出)。
  - 選檔案插入 `@<repo 相對路徑>`(claude -p 原生吃 `@file`)。
  - 列檔複用 `GET /api/:repo/tree`;路徑導航受 path-guard 約束,超出 repo root → 403,下拉顯示「已到根」。

### 4.3 Session
- 列出 `claude -r` 可恢復的 session。
- 點某個 session → 對應一個 **tmux session**,讓該 claude session 可在背景持續工作(detach 後仍跑)。
- (開全新空白工作階段交給 CLI tab;Session 專注於恢復既有 claude session,避免功能重疊。)
- UI 可 attach 進該 tmux(xterm.js)看即時輸出、可 detach。
- tmux session 命名與生命週期管理(建立 / attach / detach / 列出 / 收掉)在實作前由 BDA 出細部設計,Kelp 驗收。**此 Tab 最複雜、風險最高**。

### 4.4 CLI
- 基本 console:PTY shell,CWD = active repo root。
- `node-pty` + `xterm.js`,WebSocket 雙向。
- **⚠️ 這是完整 shell**:CWD 是 repo root,但使用者可 `cd` 出去執行任意指令(完整 RCE,非 path-guard 所能限制)。安全前提見 §2「邊界的適用範圍」與「CSWSH 防線」。

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
