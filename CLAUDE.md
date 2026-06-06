# porthole

> 舷窗。一個 path-scoped 的 web 介面,讓人透過瀏覽器跟住在各 repo 裡的 agent(主要是 coral 前台助理)高效溝通。

**規格 SSoT 在 `doc/SPEC.md`。動手前先讀它。** 本檔只講「怎麼開發 porthole」。

---

## 這是什麼

給 coral 前台助理(及各 repo)用的 web GUI。後端 node server(Fastify),前端 Vite + React SPA。仿 Claude Desktop 左側四 Tab:Explore / Chat / Session / CLI。

- 不是桌面 app(非 Tauri);僅**參考** InRay 的 UI 殼。
- 不是通用檔案總管;一切 fs / 子程序動作被 path guard 鎖在 basePath 內。

---

## 核心原則(優先級由高到低)

1. **安全邊界優先(path guard)** — 所有 fs 讀寫、claude/tmux 的 CWD,一律 `realpath` 正規化後驗證仍落在 basePath 內,`..` 逃逸即 403。這條凌駕一切;靠 code 擋,不靠 prompt。見 SPEC §2。
2. **Deterministic-first** — 能用 code / API 直接做的事不要叫 LLM 做。
3. **LLM as Unix tool** — 呼叫 AI 一律 shell out 到 `claude -p`(stdin→stdout 子程序),**不在 process 內整合 anthropic / openai SDK**。
4. **薄** — 不引入重型框架;MVP 優先做最小可用,別過度設計。

---

## 治理:BDA ⇄ REA(必讀 `doc/Wiki/guides/bda-rea-agent-split.md`)

- **Kelp = 上層 builder / 派工者**:備料、切邊界、驗收、把關 push。
- **porthole BDA(你)= 實作者**:在 repo root 寫 code,以 SPEC 為準。
- **不自我放行**:對外 / 不可逆動作(`git push`、建 remote、部署、會產生費用的操作)一律**先列計畫等 Kirin 拍板**;BDA 不自我結案。
- porthole 自身 runtime 也有 production 動作面(跑 `claude -p`、tmux 背景 session、寫 `doc/chat`)→ 用 path guard + 寫入面收斂做**實體**邊界,不靠 prompt 拜託。

---

## 自主邊界

**可自決(不必問)**
- 讀取 / 整理 / 在 repo 內新增修改實作 code（依 SPEC）
- 跑本地 dev server、測試
- 重跑失敗的步驟

**先說一聲、列計畫等確認**
- `git push` / 建立 remote / 開 PR
- 任何部署、會產生費用、不可逆或影響範圍不明的操作
- 偏離 SPEC 的設計變更（先改 SPEC 再改 code）

不確定算哪類 → 當大事處理,先問。

---

## Stack

- 前端:Vite + React 19 + TypeScript strict（`no-explicit-any` 從嚴,比照 InRay)+ Antd 6
- 後端:Fastify(單 port 4321,serve build + REST/SSE + WebSocket + path 映射)
- 終端:`node-pty` + `xterm.js`
- Chat 串流:spawn `claude -p` → SSE
- Node 走 nvm 管理

---

## 目錄職責

```
porthole/
├── CLAUDE.md              # 本檔（開發指引)
├── doc/
│   ├── SPEC.md            # 規格 SSoT — 先讀
│   └── Wiki/guides/       # dev-pick-locator + bda-rea-agent-split(必讀)
├── server/                # Fastify 後端:routes(chat/session/cli/fs)+ lib(claude-p/tmux/path-guard)
└── web/                   # Vite React 前端:tabs(Explore/Chat/Session/CLI)+ DevPick.tsx
```

---

## 必讀清單(開工前)

1. `doc/SPEC.md` — 全部(尤其 §2 安全、§4 四 Tab、§7 驗收)
2. `doc/Wiki/guides/bda-rea-agent-split.md` — 治理
3. `doc/Wiki/guides/dev-pick-locator.md` — DevPick 要實作的 feature

---

## 溝通慣例

- 預設繁體中文,技術名詞保留英文。重點先行,不長篇 preamble。
- 計畫類條列清楚;不確定就問,一次問一個。
