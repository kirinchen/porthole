# porthole 部署記錄

## systemd 常駐(本機 kirin-desktop,2026-06-06 起用)

porthole 以 **systemd user service** 常駐:開機自啟、crash 自重啟、綁 tailscale。

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

- 綁 `HOST=0.0.0.0` → 本機 + tailscale(**http://100.114.93.81:4321**)皆可達。
- 本機家用無公網直連,`0.0.0.0` 實際只開 tailscale + LAN。

---

## 📌 給 porthole BDA 的提醒

1. **改 code 後**:`npm run prod`(rebuild dist)之後**務必** `systemctl --user restart porthole`,否則 server 跑的是舊 dist。
2. **把 systemd 方式整合進 `RUN.md`**:目前 RUN.md 只寫手動 `npm run start`;正式常駐是這份 service,請補一節指向 `deploy/`。
3. **能見度與 SPEC §2**:server 預設綁 `127.0.0.1`(SPEC §2「本機 only」),但 service 用 `HOST=0.0.0.0` 開放 tailscale。這已放寬預設能見度 —— 請在 SPEC §2 補記「正式部署綁 0.0.0.0 上 tailscale」,讓文件與實際一致。
