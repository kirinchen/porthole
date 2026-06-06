# BDA ⇄ REA — 自主 agent 的「建造者 / 執行者」治理切分

> **跨專案可重用 pattern。** 任何「讓 AI agent 自主跑 production(下單 / 發文 / 改資料 / 觸發外部動作)」的專案都適用。
> 解決「怎麼讓 agent 自動幹活,又不讓它 LLM 幻覺直接污染 production」這件事。
> 參考實作：`nfa`(自動化交易判斷 agent，`doc/SPEC.md` §3、`nfa-old/CLAUDE.md`）。

---

## 問題

要 AI agent 自主跑正式環境，第一個矛盾是:

- **想自動** —— headless、定時、無人盯著就把活幹完。
- **但 LLM 會幻覺** —— 它可能「自我演化」:改自己的 prompt、放寬風控、改判斷準則、改規格。在 production 上這等於讓一個會亂編的東西**自己改自己的緊箍咒**。

最常見的壞做法:一個 all-in-one agent，既跑 runtime 又能改自己的 config / prompt / 規則。跑久了它會把「這條限制好像擋到我」當成 bug 自己鬆綁——沒有人攔。

**結論**:把 agent 拆成**兩個角色、兩種權限**,並立一條單向 invariant —— runtime 永遠不能改 builder 寫的東西。要改,只能**開卡請 builder 改**。

---

## 設計 — 兩個角色

| | **BDA**(Builder/Designer Agent) | **REA**(Runtime/Executor Agent) |
|---|---|---|
| 中文 | 建造者 / 設計者 | 執行者 / 運行者 |
| 觸發 | 人 + Claude Code 互動(dev session) | headless 自動(cron / timer / 手動 fire) |
| CWD / 範圍 | repo root，full access | 受限沙箱(`rea/{agent_uid}/`) |
| **能改什麼** | code / prompts / config / 規格 / PLAYBOOK / 文件 —— **全部** | **只**寫 report + DB 紀錄 + **開卡給 BDA**。其餘一律唯讀 |
| 智慧來源 | 人拍板 + Claude Code | PLAYBOOK 心法(BDA 寫)+ LLM 當下綜合 |
| 每 agent 幾份 | 一份(共用) | **每個 agent 一份**(各自 SCOPE / config / prompt / PLAYBOOK) |

> 命名只是代號(Builder/Runtime)。重點是**兩種權限**與下面那條 invariant,不是字母。

---

## 核心 invariant —— 單向演化

> **REA 永遠不能改 BDA 寫的東西**(prompts / config / 規則 / PLAYBOOK / 規格)。
> 任何「改」都走 **REA 開卡 → BDA 拍板改 → commit** 的流程,不靠 REA 自我演化。

```
        REA (runtime)                       BDA (builder)
   跑 production，發現問題  ──開卡(Jira/issue)──▶  人 + agent 評估、改 code/prompt
   只寫 report + DB              ◀──部署新版本──        commit、放回 production
   ✗ 不能碰自己的規則 / config                          ✓ 改一切都先列計畫等人拍板
```

- REA 的**寫入面被實體限制**(沙箱 CWD、settings deny、唯讀掛載),不是靠 prompt 拜託它乖。
- REA 唯一的「演化管道」是**開卡**:發現新 pattern / bug / 想改準則 → 開 issue 給 BDA pool。
- BDA 自己也**不自我放行**:狀態異動 / 部署 / 結案先列計畫等人(owner 是唯一 approver)。連 BDA 都不自動,REA 更不可能。

**為什麼**:把「會幻覺的東西」和「能改 production 規則的權限」**實體隔開**。LLM 可以判斷、可以執行、可以建議,但動到自己緊箍咒的那一刻必須有人(經 BDA)在迴圈裡。這是用架構擋幻覺,不是用更長的 prompt 求它別亂來。

---

## REA 的內部可以再演化(治理切分不變)

REA「怎麼跑」本身有兩種實作,**換哪種都不動上面的 BDA⇄REA 切分**:

| | **LLM-as-orchestrator** | **Task-as-orchestrator** |
|---|---|---|
| 控制流住哪 | prompt 裡(LLM 每次自己決定叫哪些工具、跑幾輪) | 編譯期寫死的 code(固定 SOP) |
| LLM 角色 | 整個流程的調度者 | **只在少數判斷點**被呼叫(研究 / go-hold-veto / narrative) |
| 優點 | 起步快、彈性高 | 確定性、可 tracking、可測、省 token |
| 缺點 | 薄、難追、非確定性、貴 | 前期要把 SOP 寫成 code |

`nfa` 的演化:v1 是 LLM-as-orchestrator(`claude -p` 當調度器),v2 改成 Task-as-orchestrator
(Java `Task` 當調度器,固定流程的 8 步寫死,只在 5 個判斷點下放 `claude -p`)。
**REA 從「一隻 LLM」變成「大半確定性 code + 少數 LLM 判斷點」,但它對 production 規則仍是唯讀、仍只能開卡給 BDA** —— 治理 invariant 一個字沒變。

> 經驗法則:固定、零判斷的步驟(拉資料、紀錄、風控硬上限)該是 code;只有**真正需要判斷 / 處理例外 / 自然語言進出**的點才呼叫 LLM。把 LLM 從「調度者」降級成「判斷點」,幻覺面積跟著縮小。

---

## 採用建議

- **何時值得**:agent 會動到難復原 / 對外 / 動真錢的東西(下單、發布、改客戶資料、觸發部署)。純查詢 / 唯讀分析的 agent 不需要這麼重的切分。
- **最小落地**:
  1. 切兩個 CWD / 兩種身分(builder repo root vs runtime 沙箱)。
  2. runtime 的寫入面用**實體手段**限制(沙箱目錄、settings deny、唯讀掛載),別只靠 prompt。
  3. 給 runtime 一條、且只有一條向上的管道:**開卡**(Jira / GitHub issue / 任何 builder 會 pick up 的佇列)。
  4. builder 端也立「不自我放行」:部署 / 結案先等人拍板。
- **框架無關**:Claude Code / 自寫 harness / LangChain / 純 cron 腳本都能套。核心是「兩種權限 + 單向開卡演化」,跟用什麼 agent runtime 無關。
- **多 agent**:runtime 每個業務 agent 一份獨立沙箱(各自 SCOPE / config / PLAYBOOK),builder 共用一個,所有 agent 開的卡進同一個 pool 由 builder pick up。

---

> 來源:`nfa`(narrative / quant trading agent rebuild)。BDA/REA 切分源自舊 `narrative-fin-agent`,
> 在 `nfa` Java rebuild 沿用並把 REA 內部從 LLM-as-orchestrator 收斂成 Task-as-orchestrator。
> 2026-06 由 Kirin + agent 在設計迭代中固化,因為「自主動真錢的 agent」需要一條防自我演化的架構級護欄。
