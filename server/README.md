# server — porthole 後端(Fastify)

> 規格見 `../doc/SPEC.md`。本檔是指路牌,實作由 porthole BDA 依 SPEC 長出來。

單一 node server(Fastify),port **4321**。同時負責:
- serve 前端 build(`../web/dist`)
- REST / SSE(Chat 串流)/ WebSocket(PTY)
- basePath path 映射:URL 第一段 = repo 名 → `<base>/<repo>`

## 預期結構（BDA 可依框架慣例調整,偏離大方向先改 SPEC）

```
server/
├── index.ts          # Fastify 啟動、路由註冊、只綁 127.0.0.1
├── routes/
│   ├── fs.ts         # Explore:列檔案樹 / 讀檔(經 path-guard)
│   ├── chat.ts       # Chat:spawn claude -p → SSE,寫 <repo>/doc/chat/
│   ├── session.ts    # Session:claude -r 列舉 + tmux 生命週期
│   └── cli.ts        # CLI:node-pty PTY over WebSocket
└── lib/
    ├── path-guard.ts # 核心安全:realpath 正規化 + base 邊界檢查(SPEC §2)
    ├── claude-p.ts   # claude -p 子程序封裝
    └── tmux.ts       # tmux session 管理
```

**path-guard 是安全命脈** —— 所有 fs / 子程序 CWD 進來前先過它。先寫它、先測它。
