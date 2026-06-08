# porthole — 啟動方式

> 規格見 `doc/SPEC.md`。porthole = path-scoped web 介面,單 port **4321**,只綁 `127.0.0.1`。

## 前置

- Node(走 nvm),已驗於 Node 24。
- `claude` CLI 在 PATH(Chat / Session 用)。
- `tmux` 在 PATH(Session tab 用)。
- basePath 預設 `/home/kirin/Desktop/project`,可用環境變數 `PORTHOLE_BASE` 覆寫。

## 安裝(第一次)

```bash
# 在 porthole repo root
npm install            # 裝根層工具(concurrently)
npm run install:all    # 裝 server + web 依賴
```

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

- service 綁 `HOST=0.0.0.0` → 本機 + tailscale(**http://100.114.93.81:4321**)皆可達。
- 本機家用無公網直連,`0.0.0.0` 實際只開 tailscale + LAN(見 SPEC §2)。

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
