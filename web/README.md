# web — porthole 前端(Vite + React)

> 規格見 `../doc/SPEC.md`。本檔是指路牌,實作由 porthole BDA 依 SPEC 長出來。

Vite + React 19 + TypeScript strict + Antd 6。仿 Claude Desktop 左側四 Tab 佈局。UI 殼可參考 InRay（`../../inray/src`),但**不依賴 Tauri**。

## 預期結構（BDA 可依框架慣例調整,偏離大方向先改 SPEC）

```
web/
├── index.html
├── vite.config.ts        # dev 時 proxy /api、/ws 到 Fastify(4321)
└── src/
    ├── App.tsx           # 左側 Tab 殼 + repo 選擇器
    ├── DevPick.tsx       # Ctrl+F12 元素定位器(移植 dev-pick-locator.md)
    ├── tabs/
    │   ├── Explore.tsx   # files tree + markdown 預覽(參考 inray features/repo)
    │   ├── Chat.tsx      # claude -p 對話(SSE)
    │   ├── Session.tsx   # claude -r 列舉 + tmux attach(xterm.js)
    │   └── Cli.tsx       # PTY console(xterm.js)
    └── lib/              # api client、SSE/WS 封裝
```

關鍵互動元素逐步補 `data-loc="頁面:元件:角色"`,讓 DevPick 指得準。
