# porthole 部署記錄

## systemd 常駐(2026-06-06 起用)

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

- 綁定走 repo root 的 `.env`(`HOST`),unit 不再寫死 Environment。目前綁 **tailscale 網卡 IP** → 只 tailnet 可達,LAN + loopback 都不開。
- 本機開瀏覽器也要用 `http://<your-tailscale-ip>:4321`(`127.0.0.1` 不再可達)。
- **⚠️ 無認證 + CLI=完整 shell(RCE)**:綁 tailscale IP = 把 shell 開給 tailnet 內所有裝置。**別**改回 `0.0.0.0`(會連 LAN 一起開)。要更嚴需加認證(見 SPEC §2 邊界適用範圍)。
- 設定不放 unit、放 `.env` 的原因:`loadEnvFile`/解析在 app 端做,單一來源;unit 設 Environment 會壓過 `.env`。

---

## 📌 給 porthole BDA 的提醒

1. **改 code 後**:`npm run prod`(rebuild dist)之後**務必** `systemctl --user restart porthole`,否則 server 跑的是舊 dist。
2. **把 systemd 方式整合進 `RUN.md`**:目前 RUN.md 只寫手動 `npm run start`;正式常駐是這份 service,請補一節指向 `deploy/`。
3. **能見度與 SPEC §2**:預設綁 `127.0.0.1`(SPEC §2「本機 only」);正式部署改由 `.env` 的 `HOST` 綁 **tailscale 網卡 IP**(只 tailnet 可達,不開 LAN)。SPEC §2 已對齊。曾短暫用 `0.0.0.0`(連 LAN 一起開)→ 因無認證 + CLI=RCE 已收掉。
