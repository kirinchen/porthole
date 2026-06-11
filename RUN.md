# porthole — 啟動方式

> 規格見 `doc/SPEC.md`。porthole = path-scoped web 介面,單 port **4321**,只綁 `127.0.0.1`。

## 前置

- Node(走 nvm),已驗於 Node 24。
- `claude` CLI 在 PATH(Chat / Session 用)。
- `tmux` 在 PATH(Session tab 用)。
- 設定走 repo root 的 `.env`(見下方「設定」)。

## 安裝(第一次)

```bash
# 在 porthole repo root
npm install            # 裝根層工具(concurrently)
npm run install:all    # 裝 server + web 依賴
```

## 設定(`.env`)

設定集中在 repo root 的 `.env`(已 gitignore),啟動時由 `server/env.ts` 載入(自行解析,不依賴 Node 版本)。第一次:

```bash
cp .env.example .env    # 再依註解填值
```

| 變數 | 說明 |
|------|------|
| `HOST` | 後端綁定位址。`127.0.0.1`=僅本機;填 tailscale IP=只 tailnet 可達;`0.0.0.0`=連 LAN 一起開(⚠️ 無認證+CLI=RCE,僅信任網路)。 |
| `PORT` | 監聽 port(預設 4321)。 |
| `PORTHOLE_BASE` | repo 掃描根目錄;URL 第一段 repo 名 → `<PORTHOLE_BASE>/<repo>`,受 path-guard 鎖住。 |

> 外部環境變數優先於 `.env`(`.env` 不覆寫既有 env)。systemd 部署時別在 unit 裡再設這些,否則會壓過 `.env`。

## Dev(開發,前後端分離 + 熱更新)

```bash
npm run dev
```

- `server`:`tsx watch` 跑 Fastify on `127.0.0.1:4321`(REST/SSE/WS)。
- `web`:Vite dev server on `127.0.0.1:5173`,proxy `/api`、`/ws` 到 4321。
- **開瀏覽器:`http://127.0.0.1:5173/<repo>`**(如 `/coral`)。第一段路徑 = active repo。

## Prod(單一 port,Fastify serve build)

```bash
npm run prod           # = npm run build && npm run start
# 或分兩步
npm run build          # web → web/dist
npm run start          # Fastify serve dist + API,單 port 4321
```

- **開瀏覽器:`http://127.0.0.1:4321/<repo>`**(如 `/coral`)。

## systemd 常駐(正式部署)

正式部署不靠手動 `npm run start`,而是 **systemd user service** 常駐:開機自啟、crash 自重啟、綁 tailscale。完整記錄見 `deploy/`(`deploy/README.md` + `deploy/porthole.service`)。

### 安裝(一次性)

```bash
cp deploy/porthole.service ~/.config/systemd/user/porthole.service
systemctl --user daemon-reload
systemctl --user enable --now porthole.service
loginctl enable-linger kirin     # 開機自啟、免登入
```

### 管理

```bash
systemctl --user status  porthole
systemctl --user restart porthole     # ← 改 code / rebuild 後要跑這個
systemctl --user stop    porthole
journalctl --user -u porthole -f      # 看 log
```

> ⚠️ **改 code / rebuild 後務必 restart**:`npm run prod` 重建 `web/dist` 後,**一定要** `systemctl --user restart porthole`,否則 service 跑的仍是舊 dist。

- 綁定由 `.env` 的 `HOST` 決定(unit 不再寫死)。目前綁 **tailscale 網卡 IP** → **只 tailnet 可達**(不開 LAN、也不綁 loopback)。
- **故本機開瀏覽器也要用 tailscale 網址**(`http://<your-tailscale-ip>:4321`),`127.0.0.1` 不再可達 —— 這是用 tailnet 成員身分當「網路層認證」、收掉 LAN 破口的代價。
- **⚠️ 安全前提**:porthole **無認證**,CLI/Session tab = 完整 shell(RCE)。綁 tailscale IP = 把 shell 開給你 tailnet 內所有裝置;**別**改回 `0.0.0.0`(那會連 LAN 一起開)。WS 另有同源檢查擋 CSWSH(SPEC §2),但只擋跨站網頁,不擋能直連的人。

## 其他指令

```bash
npm test               # path-guard 測試(安全命脈,須綠)
npm run typecheck      # server + web 型別檢查
PORTHOLE_BASE=/other/path npm run start   # 換 basePath
PORT=5000 npm run start                    # 換 port
```

## 四個 Tab 速覽

| Tab | 做什麼 |
|-----|--------|
| Explore | active repo 檔案樹 + 點檔預覽(markdown 渲染)+ 編輯 / 新增檔(寫入受 path-guard) |
| Chat | `claude -p` 對話,SSE 逐字串流,紀錄寫 `<repo>/doc/chat/<thread>.md` |
| Session | 列 claude 可恢復 session;點一個 → tmux 背景跑 + xterm attach/detach |
| CLI | PTY console(CWD = repo root),WebSocket + xterm.js |

**Ctrl+F12** = DevPick:點任一元素複製混合定位器(貼給 agent 精準對位)。
