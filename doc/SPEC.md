# porthole — SPEC(SSoT)

> 舷窗。一個 path-scoped 的 web 介面,讓人透過瀏覽器跟住在各 repo 裡的 agent(主要是 coral 前台助理)高效溝通。
> 取代純 CLI 對話的高溝通成本。

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
| 視覺主題 | 深色,**色票與 Tide 看板統一** | 單一來源 `web/src/theme.ts`,見 §3.1 |
| 後端 | 單一 node server,**Fastify** | 同時 serve 前端 build + REST/SSE + WebSocket + path 映射 |
| Chat 串流 | spawn `claude -p` → SSE | LLM as Unix tool:stdin→stdout 子程序,不整合 SDK |
| 元素定位 | 移植 `DevPick.tsx`(Ctrl+F12) | 見 `doc/Wiki/guides/dev-pick-locator.md` |

Node 走 nvm 管理。前端 strict TS,`no-explicit-any` 比照 InRay 從嚴。

---

## 2. Port / basePath / 安全(核心,不可妥協)

- 單一 port **4321**。
- **basePath = `<your-project-base>`**(原始碼內 `DEFAULT_BASE`,可由 env `PORTHOLE_BASE` 覆寫)。
- URL 第一段 = repo 名:`http://localhost:4321/coral` → `<base>/coral` 頂該 repo root;`/inray` → `<base>/inray`,依此類推。
- **path guard(REA 實體邊界)**:
  - 所有 fs 讀寫、`claude -p` 的 CWD,**一律先正規化(`realpath`)再驗證仍落在 `<base>` 之內**;任何 `..` 逃逸出 base → 直接拒絕(HTTP 403)。
  - 概念抄 InRay `inray-paths` path guard。這是把「web 變全機讀檔漏洞」擋掉的唯一防線(**僅就 fs 讀寫而言**,見下方適用範圍),**不靠 prompt,靠 code**。
  - 寫入面收斂(逐一明列才開放):
    - Chat:只能寫 `<repo>/doc/chat/`。
    - Explore 編輯:可寫 active repo 內**任一路徑**(覆寫既存或新增),仍受 path-guard 鎖在 repo root 內、逃不出 base。`PUT /api/:repo/file`。(注意:repo 內含 `.git/`、`.claude/` 等 dotfile 也在可寫範圍 → 寫 git hook 可間接執行;這在「單機自用 + 信任網路」前提下接受。)
- **攻擊面(2026-10-25 大改版後)**:CLI / Session tab 連同 PTY、tmux、WebSocket 一併退場(原 §4.3 §4.4 已刪),porthole 的動作面只剩 **fs 讀寫** 與 **`claude -p` 子程序**,兩者的路徑與 CWD 都在 path-guard 內 → **不再有「以服務執行身分的完整 RCE」**。WS 路由歸零,故 CSWSH 防線(WebSocket 不受同源政策約束、綁 loopback 也擋不住)連同 `server/lib/ws-origin.ts` 一併移除 —— 沒有 WS 就沒有那個載體。
- **仍要誠實聲明的一條**:`claude -p` 帶 `--dangerously-skip-permissions`(否則 agent 多數動作被權限提示卡住),所以 chat agent 在 CWD 下能讀寫檔、執行指令。擋它的是 path-guard 給的 CWD 與寫入面,**不是 prompt**;porthole 無認證(§8),對外的前提仍是「只在 tailnet 內、無未授權者可達」。
- **預設綁 `127.0.0.1`(loopback)**。綁定由 repo root 的 `.env` 之 `HOST` 決定(`server/env.ts` 載入;設定範本 `.env.example`)。
  - **正式部署綁 tailscale 網卡 IP**(網址 **http://<your-tailscale-ip>:4321**)→ **只 tailnet 可達**,不開 LAN、也不綁 loopback。等於用 **tailnet 成員身分當網路層認證**,收掉 LAN 破口。本機開瀏覽器也走 tailscale 網址。部署見 `RUN.md`「systemd 常駐」+ `deploy/`。
  - **不要綁 `0.0.0.0`**:那會連 LAN 整段一起開;porthole 無認證(§8),只在完全信任的網路才可。預設值仍維持 `127.0.0.1`,放寬綁定屬部署時的顯式決定(改 `.env`,不改 code 預設)。
  - 注意:tailscale/區網走 **http**(非 https),非 secure context → 瀏覽器 `navigator.clipboard` 失效,複製功能受影響(見 §6)。path guard 仍是 fs 面的實體邊界,不因綁定位址放寬。

---

## 3. 佈局

**兩個模式,頂部 header 切換**(`app:header:mode`,預設**檔案**):

| 模式 | 版面 | 用途 |
|---|---|---|
| **檔案**(`#file`) | 三欄:檔案樹(左) + 預覽/編輯(中) + **當前檔的對話**(右) | 邊編輯檔案邊跟 agent 討論「這一份」 |
| **對話**(`#chat`) | 兩欄:thread 列表(左) + 對話(右) | 把所有對話攤開來找 / 接續,不綁在某個檔上 |

**桌面(≥lg)**:檔案模式才是三欄;中央與右側交界可拖動調寬;右側面板有視窗控制
(撐滿 / 正常 / 最小化),**保活不卸載**。
**窄螢幕(<lg,992)**:單窗格 —— 檔案模式**只顯示 Explore,不掛右側對話**,要對話就切到對話模式。
門檻用 lg 而非 md:手機橫放(844×390)與小平板落在 md~lg 之間,硬塞一個對話欄只會把預覽壓扁。
檔案樹的抽屜化、header 收窄、對話模式的 `panel` 版面(thread 列表收進頂列的 List 選單)
仍看 `<md`。

```
┌──────────────────────────────────────────────────────────┐
│ porthole · 舷窗  [repo ▾]              [ 檔案 │ 對話 ]    │
├──────────────┬───────────────────────────┬───────────────┤
│ explore:tree │  explore:preview          │ chat          │
│  檔案樹       │  檔案預覽 / 編輯           │  當前檔的對話  │
│              │            ←  拖  →        │  (綁檔)       │
└──────────────┴───────────────────────────┴───────────────┘
```

- **URL 狀態**:repo 走 pathname 第一段(`/coral`),模式走 hash(`#file` / `#chat`),對話走 `?thread=`(§4.2)。
  reload / bookmark / 上一頁皆可還原;hash 純前端,server 不參與。
  舊的 `#explore` 視為 `#file`;**退場的 `#session` / `#cli` 落回 `#file`**(舊書籤不會壞成白畫面)。

### 3.1 視覺主題(與 Tide 看板統一)

深色。色票 / 字型 / 圓角跟 **Tide 看板**(`tide/src/ui/style.css`)對齊。
**單一來源 = `web/src/theme.ts`**:一份 `PALETTE` 常數,① 餵 Antd `ConfigProvider` 的 token、
② 載入時寫成 `:root` 的 CSS 變數給自寫 markup 吃。要調色只改那一處,不另開第二套。

| 變數 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0e1a24` | 頁底 |
| `--surface` | `#16242f` | 面板 / 欄 |
| `--card` | `#1d3340` | 卡片 / 留言 |
| `--line` | `#2a4452` | 框線 |
| `--text` | `#d7e3ea` | 正文 |
| `--muted` | `#7d97a5` | 次要文字 |
| `--accent` | `#3fb6c4` | 主色 / 連結 / 焦點 |

字型 `system-ui, "Noto Sans TC", sans-serif`,基準 `14px/1.5`,圓角 10。Antd 走 `theme.darkAlgorithm` + 上表 token。

**連圖一起深色**,否則深色頁面中間會爆出一塊白:
- mermaid `theme: 'dark'`、Excalidraw `theme="dark"`(皆對齊 Tide)。
- d2 固定 `--theme=200`(Dark Mauve);**不要用 `--dark-theme`** —— 那是「瀏覽器 prefers-color-scheme
  為深色才套」,使用者系統設亮色就會出白圖(Tide 踩過)。
- CM6 編輯器的語法高亮不能用內建 `defaultHighlightStyle`(亮底配色,深色上讀不到)→
  `web/src/lib/cmTheme.ts` 以 `CODE_TOKENS` 自建一份,**與預覽的 `.tok-*` 共用同一組色值**;
  游標 / 選取 / gutter 也要明寫,CM6 預設是亮底的。

---

## 4. 功能規格

### 4.1 Explore
- files tree(抄 InRay `features/repo`),根 = active repo root。
- **內容搜尋(find in files;Eclipse Ctrl+H 式)**:工具列搜尋鈕 / **Ctrl+H** → 左側樹面板內切換成搜尋 UI(搜尋框 + `Aa` 區分大小寫 / `.*` 正則切換 + 結果依檔分組,命中片段標黃底);返回鈕切回樹。後端 `GET /api/:repo/search?q=&regex=&case=`:自 repo root 遞迴 Node walk(path-guard;跳 `SKIP` 目錄 / >2MB / binary(前 8KB 見 NUL)),逐行比對(regex 可選、預設不分大小寫),命中回 `{path, matches:[{line,col,len,text}]}`;命中總數上限 2000(達到即 `truncated`),過長行以命中為中心開窗(前綴 `…`)。點命中 → 開檔;**markdown 進 CM6 編輯器並捲到該行**(preview 無任意行錨點,故用 `initialLine`),其他檔開啟(textarea)。**點檔名列(分組標頭)→ 開該檔預覽(不跳行不進編輯)並自動退回檔案樹**,祖先目錄展開、該檔反白(搜尋面板與樹共用左側同格,不退回就看不到樹)。
- 點檔案 → 右側預覽(markdown 走 remark/rehype 渲染;圖片(png/jpg/gif/webp/svg/bmp/ico/avif)以 `<img>`、**音訊(mp3/wav/ogg/opus/m4a/aac/flac)以 `<audio>`、影片(mp4/m4v/webm/mov)以 `<video>`、PDF 以 `<iframe>`** 顯示,來源 `GET /api/:repo/raw`(path-guard、依副檔名給 content-type、**串流 + Range** 讓播放器能拖進度);**其他二進位(`/file` 前 8KB 見 NUL → 415)或 > 2MB 的文字檔(413)不報錯,改顯示「無法預覽 + 下載」**(`MediaPreview`);**`.excalidraw`** 以 Excalidraw 白板編輯器開(自由繪圖,Google Drawing 式;存檔 serializeAsJSON 寫回 JSON,Ctrl+S / 儲存鈕;`@excalidraw/excalidraw` lazy 載入);**`.env`(含 `.env.*` / `*.env`)** 預覽美化成 KEY/VALUE 表(`EnvView`:註解分段、值可一鍵複製 / 整體遮罩,編輯仍走原始 textarea 不破壞格式);其他純文字)。
- **多分頁(VSCode 式)**:預覽工具列頂端為分頁列(`TabStrip`,`data-loc=explore:tabs`)——開啟的檔案各成一分頁(檔名 + `×` 關閉,中鍵亦關;點分頁切換;active = `selPath`,`openTabs` 有序清單,去重不重複)。**開啟規則**:tree 點檔 / 新檔 → 累積新分頁(`'new'`);**md link 一般點 → 取代目前分頁**(`'active'`;目標已開則切過去)、**Ctrl/Cmd+click → 開新分頁**(`'new'`,保留目前)——`porthole:navigate` detail 帶 `newTab`,`navigateTo(...,tabMode)` 據此 `noteOpenTab`。關 active 分頁 → 切鄰居(右優先);關最後一個 → 清空預覽。換 repo 清空分頁(記憶體態,不跨重載)。**每分頁保留編輯狀態**:切分頁時 `snapshotActiveTab` 記下該分頁的「編輯中 + 未存草稿 + 編輯器頂端行」(`tabStateRef`,path→state);切回時還原(續編、未存改動還在、捲動位置回到原處)。存檔 / 取消 / 關分頁 / 換 repo 清掉記錄。**edit 狀態同步 URL**(`?edit=1`,與 `?sec` 並存):`writeUrl` 依 `editingRef` 帶上、`editing` 變更時 effect 補寫;reload / 上一頁 / deep-link 帶 `?edit=1` → 開檔後直接進編輯(`navigateTo(...,wantEdit)`,以磁碟內容;`.excalidraw` 例外)。
- **下載檔案**:預覽工具列「下載」鈕(當前開啟檔,新檔/編輯中不顯示)+ 左側樹每個**檔案**節點的下載動作 → `GET /api/:repo/raw?download=1`(`Content-Disposition: attachment`,`filename*` RFC5987 編碼支援中文;raw 走串流故**不設大小上限**,仍經 path-guard;不帶 `download` 時維持 inline 供圖片預覽)。前端以隱藏 `a[download]` 觸發,不經 SDK。
- 點**資料夾** → 中央顯示該夾內容(可點:檔案開檔、子夾鑽入)+ 其 `README.md`(若有,case-insensitive)渲染於下。
  - **中央工具列「新增」鈕**(`explore:folder:file:new`,僅資料夾檢視顯示):開與左側樹同一個新增檔案 Modal(建在 `baseDir` = 當前資料夾)。空資料夾時左側樹的新增鈕離得遠、手機收起樹更看不到 → 在看著的地方給入口。
  - **grid / list 兩種檢視**(仿檔案總管,右上切換鈕,偏好記 `localStorage`)。**list** 模式以表格顯示 名稱 / 修改時間 / 大小 / 類型,**欄頭點擊排序**(名稱 localeCompare、時間 mtime、大小 bytes、類型副檔名);資料夾預設在前(後端 tree 已 dir-first 排序,list 未主動排時維持)。mtime/size 由 `GET /api/:repo/tree?stat=1` 附上(**opt-in**:僅資料夾視圖帶,左側 tree 不帶以免每筆 `stat` 拖慢)。
  - **貼上圖片**:檢視某資料夾時,貼上(Ctrl/Cmd+V)剪貼簿圖片 → 自動命名 `pasted-<YYYYMMDD-HHMMSS>.<ext>` 存入該夾(base64 走 `PUT /api/:repo/file`,path-guard;多張補 `-1`/`-2`),存後刷新視圖;非圖片內容不攔(放行)。事後可用樹節點「改名」調整檔名。
  - **編輯 markdown 時貼上圖片**:CM6 編輯器內貼上剪貼簿圖片 → 存到**目前檔所在目錄**(`pasted-<YYYYMMDD-HHMMSS>.<ext>`,base64,path-guard),並於游標插入 `![](檔名)`(同目錄故相對路徑=檔名);非圖片內容放行(正常貼文字)。**預覽渲染相對圖片**:`Markdown` 的 `img` 以「目前開啟檔」為基準解析相對路徑成 `GET /api/:repo/raw`(`MdImg`,同 `MdLink`),外部 / `data:` 原樣 —— 否則相對於瀏覽器 URL 會 404。**編輯器 live-preview 內嵌圖片**:CM6 對 `Image` 節點在**非 active 行**整塊換成 `<img>` widget(`ImageWidget`;src 同 `resolveRawSrc` 解析成 raw,`load` 後 `requestMeasure` 修行位,載入失敗退成 `🖼 alt`),**點圖片行**→該行 active→露出 `![alt](url)` 原始碼供編輯。**插入圖片 GUI dialog**(`ImagePickerDialog`,編輯 md 時工具列「圖片」鈕 `data-loc=explore:img:open`):可**瀏覽 repo 既有圖片**(以縮圖 `api.rawUrl` 顯示,可鑽入子夾 / 上一層 / breadcrumb 跳)點選插入,或**上傳新圖**(從電腦選檔 → base64 存到目前瀏覽目錄 → 立即出現在清單)。選中 → `MarkdownEditorHandle.insertAtCursor` 在游標處插 `![](相對路徑)`(路徑以目前編輯檔目錄為基準算相對、逐段 `encodeLinkSegment`)。同一 dialog 亦可從**空白行右鍵選單**(`flowmenu`)的「🖼 插入圖片」開啟(先把游標移到該空白行,再派 `porthole:insert-image` 事件開 dialog,插入即落在該行)。
- **編輯**:預覽區「編輯」鈕 → markdown 走 CM6 Obsidian 式 live-preview、其他純 textarea → 儲存(`PUT /api/:repo/file`)。「儲存」鈕存檔並回預覽;**Ctrl/Cmd+S** 存檔但**不離開編輯**(派 `porthole:save-file`,讀 draftRef)。進編輯**延續 preview 捲動位置**:取 preview 頂端當前 heading(第 N 個)→ 對應原始碼第 N 個標題行(`headingLineNumbers`,同 `parseHeadings` 跳 fenced code 規則),CM6 mount 後捲到該行並置游標行首。**退編輯(取消 / 儲存)反向延續**:讀編輯器頂端行(`MarkdownEditorHandle.topLine`,`posAtCoords`)所屬的第 N 個 heading → 回 preview 後捲到第 N 個標題(rAF 等重新渲染;換檔則作廢避免捲錯檔)。**fenced code 語法高亮**:`markdown({ codeLanguages })` 精選常用語言(js/ts/py/java/json/rust/go/sql/yaml/html/css/xml/cpp/shell),各語言 `LanguageDescription` lazy dynamic import(code-split),配 `syntaxHighlighting(defaultHighlightStyle, {fallback})`;清單外語言(如 cobol)維持純文字。**預覽(react-markdown)的 code block 亦共用同一語言清單**(`lib/codeLanguages` + `CodeBlock` + `highlightTree`/`classHighlighter`),產 `tok-*` class 配 `styles.css`(色值對齊 `defaultHighlightStyle`,如 keyword `#708`),與編輯器高亮一致;語言 parser lazy 載入且與編輯器共用快取(`LanguageDescription.support`)。預覽 code block 右上角有**複製鈕**(`md:code:copy`,hover 顯示 / 觸控裝置常駐;複製的是原始碼字串而非 DOM 選取 —— 高亮切成多個 span,選取易漏字),走 `lib/clipboard` 的 `copyText`(非安全內容無 `navigator.clipboard` → `execCommand` fallback),成功後 icon 暫變勾號。
- **目錄(outline)**:markdown 預覽工具列「編輯」鈕旁的目錄鈕(`Outline`)→ click 展開 Popover 列出全部 ATX 標題(h1–h6,依層級縮排),點某項捲動到該標題。跳轉靠「第 N 個標題 ↔ preview 第 N 個 heading 元素」對位(`parseHeadings` 與渲染皆跳過 fenced code),免 heading id / rehype-slug、不怕重複標題。
- **章節定位錨點(GitHub 式)**:預覽標題 hover 顯示左側 `#` 錨點(`lib/heading` + `Markdown headingAnchors`)。標題設 `id` / `data-heading-slug`(slug 規則與 `#section` 自動完成一致 —— 去 inline markdown、空白→`-`、保留中文;同名標題補 `-1`/`-2` 序號)。點錨點 → 平滑捲動 + 短暫高亮 + 網址列更新為可分享的 `?sec=<slug>` deep-link(保留 `#tab`)+ 複製完整 URL 到剪貼簿。**deep-link**:開啟帶 `?sec=` 的網址(初次載入 / 連結導航 / 上一頁)→ 渲染後自動捲到該章節(`scrollSectionWhenReady`,rAF 重試,換檔即中止)。**站內 `#slug` 連結**(含 `#` 自動完成插入的章節連結):同檔直接捲動不重載;`?sec=` 在 tab 切換間保留(`App` tab→hash effect 保留 `location.search`)。**編輯器(CM6)hover 標題行**:於標題**左側**浮出灰色 `LinkOutlined` 錨點(與預覽 `.md-anchor` 一致 —— 同 icon、`#8c8c8c` hover `#1677ff`;純 DOM,移到錨點上不消失、離開帶延遲、捲動收起),點擊複製該章節的 `?sec=<slug>` deep-link。slug 走 syntaxTree 列舉 `ATXHeading[1-6]`(排除 fenced code 內 `#`)並以相同 seen Map dedupe,與預覽 / 自動完成的 slug 一致。
- **選字插入 / 編輯連結**(CM6 編輯 + 表格 cell):選取文字後**右鍵**點選區 → 於滑鼠處浮出「🔗 連結」鈕(取代原生選單;純 DOM 共用 `lib/linkTooltip`,不引 Antd 進 CM6 樹)。點鈕派 `porthole:edit-link` 事件 → 由 `MarkdownEditor` 的 antd Modal 接手(連結文字 + 網址;網址必填才可套用),套用以 `[文字](網址)` 寫回。**來源解耦**:`detail.apply(md)` callback —— CM6 走 `view.dispatch` 取代範圍(選區落在既有 `Link` 節點內則整段替換 + `linkNodeAt` 預填 href);**表格 cell**(`TableBlock` widget 為 `MarkdownEditor` 子樹,共用同一 Modal)走改寫 cell 子字串(選取本身已是 `[t](u)` 則 `parseInlineLink` 預填)。**cell 連結縮起**:cell 失焦且含 `[t](u)` 時,於 textarea 上疊 overlay 只顯示連結文字(縮起 `](url)`);overlay 本體 `pointer-events:none` 讓非連結處點擊穿透回 textarea(精準定位游標、進原始碼編輯),唯 `<a>`(`.ph-cell-link`)可互動 —— hover 跳「🔗 編輯連結」tooltip(點開同一 Modal、`apply` 替換該連結)、點連結進編輯。右鍵不清選取,故不需保焦;detail 於右鍵當下就建好(選區已知),之後失焦不影響套用。無選取的右鍵 → 交給 flowContextMenu(空白行圖表選單)/ 原生選單。**開啟連結**:tooltip 在 `detail.url` 非空(既有連結)時另列「↗ 開啟連結」鈕 → `openLink` 以目前檔為基準解析 url,外部新分頁 / 站內派 `porthole:navigate`(依多分頁規則開啟)。 **網址欄路徑補全(VS Code 式)**:Modal 的網址欄(`PathUrlInput`,下拉 `data-loc=explore:edit:link:pathhint`)在輸入以 `.` / `..` / `/` 起手時浮出站內路徑 hint —— `.`=目前編輯檔所在目錄、`..`=上一層、`/`=repo 根;繼續打字過濾,選資料夾補 `/` 續補下一層、選檔案填入並收起;↑↓ 選、Tab/Enter 套用、Esc 只關下拉(不關 Modal)、滑鼠可點。`https://` 等外部網址與含 `?` 的 query 不觸發。列檔複用 `GET /api/:repo/tree`(單層),爬出 repo root 由 path-guard 擋(403 → 顯示「已到根」)。填入值為**相對路徑並保留使用者起手的 `./` `../` `/` 風格**;中文檔名原樣不 encode(`resolveLink` 讀取時 safeDecode),只逸出會破壞 `[文字](網址)` 語法的空白與括號。**章節錨點補全(`#`)**:網址含 `#` 時改列**目標檔的標題(h1–h6)**當 section location link —— 無路徑的 `#foo` / `##foo` 列**目前編輯檔**標題(`getCurrentFile` 內容),`./a.md#foo`、`/a.md#foo` 等列該檔標題(`api.file` 取內容,`lib/heading.headingSlugs` 解析、跳 fenced code);`#` 起手數量正規化(`##`→單一 `#`),選中填入 `<路徑>#<slug>`(slug 與預覽錨點 / `?sec=` 一致),為終點故收起。解析抽成純函式 `lib/linkPath`(`parseLinkPathQuery` / `applyLinkPathChoice` / `parentInsertBase` / `parseLinkSectionQuery` / `applyLinkSectionChoice`),有單元測試(`web` 的 `npm test`,node:test)。
- **@/# 自動完成**(CM6 編輯):打 `@` 選檔(以**目前編輯檔目錄**為基準、lazy 逐層、資料夾續查、`../` 往上夾在 repo root)、`#` 選章節(`@file#` 取該檔標題 / 單獨 `#` 取目前檔標題),可混用 `@abc.md#chat1`(`lib/mentionComplete`)。
- **新增**:檔案樹「新檔」鈕 → 輸入相對路徑(中間目錄自動建立)→ 編輯後儲存。輸入框打 `.` 出副檔名 smart hint(VSCode 式,md / excalidraw 等);新建 `.excalidraw` 直接開白板編輯器(非文字),首存後補進樹。
- **樹節點動作**(hover 圖示,檔案 / 資料夾皆有):改名(同層)、**移動到資料夾**(TreeSelect lazy 只列資料夾 → 換目錄,沿用 `POST /api/:repo/rename {from,to}`,雙路徑 path-guard、目標已存在回 409;移動資料夾時擋自身/子孫不可為目標)、刪除(資料夾連內容)。開啟檔或其祖先夾被改名 / 移動 → 同步更新 `sel`/網址 / 樹反白並展開新位置。
- 寫入受 path-guard 鎖在 active repo root 內(見 §2 寫入面)。
- **mermaid**:
  - **預覽**:純渲染 ```mermaid 圖(securityLevel=strict),不帶編輯控制(預覽即看)。
  - **編輯(CM6)**:每個 ```mermaid block 換成互動 box,右上 tab 切 **預覽 / 編輯 / GUI**;
    **flowchart / stateDiagram / erDiagram / classDiagram / sequenceDiagram / architecture-beta / mindmap 有 GUI tab**(各對應專屬編輯器),其餘只有 預覽 / 編輯。
    套用直接改寫 CM6 文件對應區塊,隨檔案一起存。空白行右鍵選單可一鍵插入各圖型範例(GUI 可編輯)。
  - GUI 編輯器(節點圖型用 React Flow + dagre,共用:雙擊改字、拖把手連線、Delete 刪、新增、復原/重做、複製/貼上、全螢幕;「套用」正規化重寫並回 preview;**Ctrl+S / 儲存** = 存檔寫回磁碟但**留在編輯器**,跨 widget remount 以 sessionKey 保留 GUI 狀態):
    - **flowchart**(`mermaidFlow` + `FlowEditor`):矩形/圓角/菱形節點 + 有向邊 + 邊標籤 + 方向。
      樣式語句(`classDef` / `class` / `style` / `linkStyle` / `click`)**不是節點**:原樣保留、存檔寫回
      (引用到 GUI 刪掉的節點會濾掉,免得 mermaid 憑空生回來);`:::cls` 掛在節點上。GUI 照 classDef
      的 fill / stroke / color 畫節點,淺色 fill 沒指定字色就用深字。
    - **state diagram**(`mermaidState` + `StateEditor`):狀態 + 起點/終點([*]) + 轉移標籤 + 方向。
    - **ERD**(`mermaidErd` + `ErdEditor`):實體(屬性 type/name/PK/FK/UK/註解)+ 關係(左右 cardinality + 識別/非識別 + 標籤)。
    - **class**(`mermaidClass` + `ClassEditor`):類別(stereotype + 成員 visibility/attr/method)+ 關係(繼承/組合/聚合/關聯/依賴/實現 + multiplicity + 標籤)。
    - **sequence**(`mermaidSequence` + `SequenceEditor`,**清單式表單非畫布**):participant/actor(alias)+ 有序訊息(8 種箭頭 + activation)。
    - **architecture**(`mermaidArchitecture` + `ArchitectureEditor`):group(可巢狀)+ service(icon/title)+ junction + 邊(L/R/T/B 側接點 + 箭頭方向 + group 端點)。
    - **mindmap**(`mermaidMindmap` + `MindmapEditor` + `mindmapGraph`):縮排式樹(單 root 不變式)+ 節點形狀(預設/方/圓角/圓/六角/雲/爆炸)+ icon/class;階層用邊表達,拖把手連線=改 parent(防環/防多 root),新增子/兄弟、刪子樹。
      **改 parent 一定會換掉 target 原本那條 parent 邊**(樹:一節點只有一個 parent)→ 換完 message 明講「X 由 A 改掛到 B」並自動重排版 + 重框視野,否則看起來像「拉了新線、某條既有的邊憑空消失」。邊 id 由 target 導出(`me-<target>`),不用遞增序號,結構上排除撞號蓋邊。空文字節點序列化成 `id[" "]`(mermaid 文法不接受 `id[""]`,會整張圖 parse 失敗)。圖 ⇄ 模型 的純邏輯抽在 `lib/mindmapGraph`,連線→存回→讀回的 round-trip 有單元測試。
    - 各圖型只支援其子集;subgraph / composite state / loop/alt 等超出子集者退回純文字編輯。
  - mermaid / React Flow 皆 lazy-load,不進主 bundle。
- **連結內部導航**(CM6 live-preview):點 markdown 連結 → 外部(他站 / mailto)新分頁;站內(相對含 `..` / 絕對 `/<repo>/<path>` / 本站完整 URL)→ 開檔(中央預覽 + 樹逐層展開反白)或資料夾(展開反白不開檔),tab 跟連結 `#tab`(explore/chat/session/cli)。URL 雙向 deep-link:`/<repo>/<file_path>#<tab>` 載入即開、開檔即同步網址。`lib/pathLink` 解析 + `porthole:navigate` 事件(App 切 repo/tab、Explore 開檔/展開)。
  - **動機**:D2 容器是一等公民,原生支援「**容器對容器**」邊(mermaid architecture-beta 做不到——其 group 不能當邊端點)。
  - **渲染**:走後端 shell out `d2` CLI(SPEC §1「as Unix tool」):`POST /api/d2/render {src}` → stdin→stdout 取 SVG;前端只收 SVG(輕)。binary 路徑由 `.env` 的 `D2_BIN` 設定(預設 `d2`,吃 PATH);未安裝不影響其他功能。SVG 注入前淨化(去 script / on* / 危險協定連結)。
  - **編輯**:每個 ```d2 block 換成互動 box(預覽 / 編輯 / GUI),與 mermaid 共用 CM6 widget 機制(`FenceWidget`,每語言各自計數);套用直接改寫文件。
  - **GUI 編輯器**(`lib/d2` + `D2Editor`,React Flow + dagre):container(可巢狀,可當邊端點)+ shape + 邊(4 種箭頭 + label);container 與 shape 四邊皆有接點。擋 D2 layout 非法邊(自連、container↔後代/祖先)。序列化 id 自動處理 D2 保留字 / 特殊字元引號。
  - 子集:style/class/sql_table/icon/near 等進階語法退回純文字編輯。
- **表格(GFM table GUI)**(`lib/mdTable` + `TableBlock`):CM6 編輯時每個**行首** GFM 表格換成試算表式 grid widget(沿用 `Table` lezer 擴充 + block widget 機制,與 mermaid/d2 同計數對位);可直接改 cell、加/刪列與欄、切每欄對齊(左/中/右);「原始碼」tab 直接編 pipe 語法,無法解析時顯示錯誤(不靜默丟棄 / 不假存)。空白行右鍵選單「＋ 表格」一鍵插入。
  - **寫回策略**:cell 打字只改本地 model(不動文件 → 不 remount → 不掉焦);flush(失焦離開 widget / Ctrl+S)才序列化寫回;結構變更(加刪列欄、對齊)即時寫回(離散動作,不依賴焦點)。序列化逐欄補寬對齊、`\|` 逸出。
  - **邊界**:只 widget 化行首表格 —— blockquote(`> `)/ 清單縮排內的表格保留純文字編輯(避免連前綴一起換掉而破壞結構)。預覽(非編輯)仍以 react-markdown + remark-gfm 渲染 HTML `<table>`。

### 4.2 Chat

**形狀照 Tide 看板的留言面板**(`tide/src/ui/CommentPanel.tsx`)。那支的檔頭註解寫著「版面參考 porthole 右側 chat」——
現在反過來抄回來:Tide 那邊已經把留言卡 / 草稿 / job 狀態 / ⚙ 參數這些細節磨過一輪,porthole 不必再踩一次。

- 透過 `claude -p` 跟 active repo 的 agent 對話(coral → coral 前台助理)。子程序 `claude -p "<prompt>"`,
  CWD = active repo root,stdout 以 **SSE** 串回前端逐字顯示。
- **訊息呈現 = 留言卡**(不是左右氣泡):每則 `@you` / `@<repo>` + 時間 + 🔗(複製該則 deep-link
  `?thread=<t>&turn=<n>`;錨點走 query 不走 hash —— hash 已被模式占用)+ markdown 內容。
  agent 回覆裡的 ```mermaid / ```d2 照樣渲染成圖(共用 Explore 的 `Markdown` 元件;Chat 僅呈現,
  不提供 GUI 編輯)。`?turn=` 只在**換對話**時才從網址清掉,同一條對話要留著,否則 deep-link
  會被初次同步自己抹掉。
- **composer**:`@` tag agent / `.` 叫檔案(見下)、⌘/Ctrl+Enter 送出、⚙ 展開參數、送出鈕。
  **草稿自動存**(per thread,`localStorage`,debounce 400ms;換 thread 載該 thread 自己的草稿,
  送出成功才清)—— 刻意做在 onChange 而非 effect:換 thread 那一瞬間 value 還是舊的、key 已是新的,
  用 effect 會把 A 的草稿存到 B 名下(Tide 踩過)。
- **⚙ 參數**(使用者偏好,記 `localStorage`,不綁 thread):`model`(留空 = 該 CLI 自己的預設)、
  `effort`。引擎固定 `claude`(§1:LLM as Unix tool,porthole 只走 `claude -p`)。
  可選值由後端白名單給(`GET /api/chat/engine` → `{engine, models, efforts}`),前端不自己編清單 ——
  argv 不經 shell 已擋掉注入,但把任意字串當 flag 丟給 CLI 會整趟起不來。
- **job registry(跑著的那輪看得到、停得掉)**:後端記 in-flight run(`thread → {state, startedAt, model, effort}`)。
  - `GET /api/:repo/chat/jobs/:thread` → `{job}`(無則 `null`)
  - `DELETE /api/:repo/chat/jobs/:thread` → SIGTERM 那支 `claude -p`(已 append 的 turn 不回捲)
  - 開 thread / 重整 / 另一台瀏覽器進來都先問這支 → 不必再靠「檔尾是 Human turn」去猜(那只是 fallback,
    見下方 `chat:pending`);後端重啟則 registry 隨記憶體消失,退回 fallback。
  - **client 斷線不 kill 子程序**:關分頁 / 重整 / 切走都讓那輪跑完並 append 到檔案(見下一條)。
    要停就明確打 DELETE。斷線後 SSE 寫入會失敗 → 吞掉,不讓它炸掉 handler。
- **某個檔的預設對話**:`GET /api/:repo/chat/for-file?path=` → `{name, title, exists}`(§4.2.1)。
- **active thread 存進 URL**(`?thread=<name>`,`replaceState` 不灌歷史;`default` 不寫參數):reload / 切模式回來都還在同一個 thread,也可直接把連結分享成 deep-link。換 repo 時由 App 重寫 pathname 自然清掉。Explore 的 `writeUrl` 會**保留** `thread`(同 `?sec` / `?edit=1`)—— 不留著的話在 Explore 開個檔就把 Chat 的 thread 從網址抹掉。
- **串流狀態 per thread**(`streamingThreads: Set<string>`,非單一 boolean):在 A 送出後切到 B 仍能送出(composer / 送出鈕只鎖住**正在串流的那個 thread**),thread 列表對正在跑的 thread 顯示 `chat:thread:running` 轉圈。送出時**捕捉當下的 thread 名**(非讀 `active`),且:① SSE 的 `delta` 只在該 thread 仍是 active 時才寫畫面(否則 A 的回覆會逐字接到使用者已切過去的 B 上);② 首輪自動命名的 `setActive` 只在使用者仍停在該 thread 時才做 —— 否則會把人從正在看的 thread 拉走,**下一則訊息就被寫進錯的 thread 檔案**(實際發生過:`kelp-credential-management-keyfp-registry.md` 混進了 `ssh-tmux-control-windows-laptop` 的一輪)。切走的那輪不中斷(後端照跑照 append),切回來由下一條的輪詢補齊。
- **重整後仍在跑的那輪**(`chat:pending`):SSE 連線隨 reload 斷掉,但後端那趟 `claude -p` 還在跑、跑完照樣 append 到檔案(實測 16:01 送出 → 16:03 reload → 16:05 才寫完)。開啟 thread 時先問 job registry;registry 沒了(後端重啟過)而**檔尾是 Human turn 沒有 Assistant** → 仍視為「該輪可能仍在執行」,顯示提示(含「立即重讀」鈕)並每 5 秒輪詢該檔(上限 60 次 = 5 分鐘),assistant turn 一出現就自動補進畫面並停止輪詢。送出新訊息 / 開新 thread 會清掉此狀態(改由 SSE 接管)。**重新 attach 串流**(回看逐字輸出)需後端緩衝 in-flight 輸出,未實作。
- **對話記憶**:`claude -p` 每次是 stateless 一次性呼叫,故送出前把該 thread 先前的對話紀錄(turn markdown)當 context 接在最新訊息前一起餵入(尾端取最近 ~120KB),agent 才有上下文。
- **紀錄持久化**:每個 thread 寫成一個 markdown 檔到 `<repo>/doc/chat/<thread>.md`(human + assistant 輪流,append)。
- **檔名 vs 顯示標題**(`lib/chat-title`):**檔名一律英數 / `_` / `-`**(自動命名為 kebab-case slug;跨工具 / git / URL 都安全),中文放在檔案**第一行 `# 標題`**。`GET .../chat/threads` 每筆附 `title`(= 檔首第一個 H1,只讀前 4KB;遇 `## ` turn 標頭即停,故內文的 `# ` 不算)與 `link`(§4.2.1),列表與 topbar 顯示 `title || name`、`title` 屬性仍給檔名。舊檔沒有 H1 → `title: null` → 退回顯示檔名。**標題存在檔案裡**才會跟著檔案走(搬移 / clone / 在 Explore 看都還在),不必另存 index 去 drift。
- **首輪自動命名**:新 thread 預設 `thread-<ts>`;第一輪回覆完成後,後端 `POST .../threads/:thread/rename` 用**一次** `claude -p` 同時要到「繁中標題 + 英文 slug」(兩行輸出,`parseGenTitle` 解析),標題寫進檔首 H1(`setH1`:已有則取代該行,不會變兩個 H1)、slug 經 `fs.rename`(path-guard + 衝突加 `-N`)。綁檔的 thread 只換檔名的 `<slug>` 段,`-<file>-<hex12>` 後綴保持不動(§4.2.1)。生不出或同名則維持原名。
- **手動改名**:topbar 改名鈕(`chat:rename`)→ 同 rename 端點帶 `{to}`。`{to}` 即**顯示標題**(可中文),一律寫入檔首 H1;**檔名取 `slugify({to})`**(與自動命名同一套 kebab-case:「3090 24G 價格走勢」→ `3090-24g`,而非 `safeThread` 逐字換底線的 `3090_24G_____`);slug 為空(純中文)→ 檔名維持原樣,只改標題。空 thread(尚無檔)則本地改名,下次訊息寫新檔。
- 取代 `claude-workbench/plugins/chat`(該方案太難用,porthole 不沿用其機制)。
- thread 列表:讀 `<repo>/doc/chat/*.md`。
- **composer mention**:兩種觸發,都要在行首或空白後(`foo.md`、`a@b` 不算),下拉同一個
  (`data-loc="chat:composer:mention"`);鍵盤 ↑↓ 選、Enter/Tab 選中、Esc 關(下拉關閉時 Enter 換行)。
  觸發偵測是純邏輯 `web/src/lib/mentionToken.ts`。
  - **`@` = tag agent**:agent 就是 basePath 下的兄弟 repo(相對當前 repo 即 `../*`,不含自己),
    選了插入 `@<repo> `。送出時後端掃訊息裡的 `@<repo>`(只認真的存在的 repo),在 prompt 前綴補一段
    `@kelp = ../kelp` 對照(`mentionedAgents` / `agentContext`),否則 claude 不知道 `@kelp` 指哪。
  - **`.` = 叫檔案**:`.` 列 repo 根、`./doc/` 續查、`.cl` 篩根目錄 dotfile;選資料夾續查下一層、
    `..` 回上層;選檔案插入 `./<repo 相對路徑>`(CWD = repo root)。根目錄下沒對到任何檔(`...`、`.)`
    這類標點)不跳空下拉。列檔複用 `GET /api/:repo/tree`;受 path-guard 約束,超出 repo root → 403,
    下拉顯示「已到根」。
  - 檔案編輯器(CM6)的 `@` / `#` 自動完成是另一套(`lib/mentionComplete`),不受此規則影響。

#### 4.2.1 綁檔對話(file-linked chat)

**一個檔,一條預設對話。** 在檔案模式開著某個檔 → 右側對話就是那個檔的預設對話(沒有就現開一條,
第一次送出才真正落檔)。概念照 kelp `doc/Wiki/guides/in-context-agent-chat.md` 的四要件:
入口在物件旁、自動附上脈絡、由負責者回答、一個物件一條串。

- **檔名規則**(`<repo>/doc/chat/`):`<slug>-<file>-<hex12>.md`
  - `<slug>` = 主題 slug(首輪自動命名產生;還沒命名時固定 `chat`)
  - `<file>` = 綁的檔名**含副檔名**,`.` → `-`、其餘非 `[A-Za-z0-9_-]` → `_`、截 48
    (`silent-story-ide.md` → `silent-story-ide-md`)
  - `<hex12>` = `sha256(<repo 相對**完整路徑**>)` 的前 12 碼 hex。**這才是識別碼**:
    路徑多深、檔名是不是中文,檔名都只多 12 字;不同夾的同名檔、以及收斂後長得一樣的
    中文檔名(`我的筆記.md` / `你的筆記.md` 都收斂成 `____-md`)都靠它分開。
    `<file>` 段純粹是給人看的
  - 例:`doc/note/silent-story-ide.md` 的對話,開場時檔名 `chat-silent-story-ide-md-3f2a1b9c4d5e.md`,
    首輪自動命名後變 `ide-design-review-silent-story-ide-md-3f2a1b9c4d5e.md`(只換 `<slug>` 段)
- **一個檔可以有不只一條**:`for-file` 給的是**預設**那條(最近一條綁它的);右欄的「新對話」
  (`?new=1`)會再開一條綁同一個檔的,名字撞到就加 `-2`。
- **權威來源在檔案裡,不是檔名**:檔首(H1 之後)寫一行 `<!-- porthole:link <repo 相對路徑> -->`。
  檔名只是讓人在 `doc/chat/` 裡一眼看出「這條在聊哪個檔」;改名 / 搬檔後以註記為準。
- **反查**:`GET .../chat/threads` 每筆回 `link`(讀前 4KB 的註記)。要找某檔的預設對話 →
  先比 `link` 註記,再退回檔名後綴 `*-<file>-<hex12>.md`;都沒有 → 開新的。
- **檔案模式的對話列表只列這個檔的**(`chat:list:toggle` → 以 `link === 開著的檔` 過濾;
  正在看的那條一定留著,因為它可能還沒落檔)。右欄的身分就是「這個檔的對話」,把整個 repo
  的對話倒出來反而找不到東西。**對話模式**(`full`)才列全部。
- **列表列與 topbar 都顯示綁的檔**(`chat:thread:item:link` / `chat:link`):太長的路徑把**前面**
  收成 `…/<檔名>`(JS 算,不用 CSS `direction: rtl` 省略 —— 那招會把路徑裡的 `/` 當中性字元重排),
  完整路徑放 `title`。點它 → 檔案模式打開那個檔:**對話模式另開分頁**(整頁都是對話,就地切模式
  會把正在讀的對話收掉),檔案模式則就地導航。
- **對話模式左右可拖**(`chat:list:grip`,做法同 tide 留言面板的 `.cp-grip`):左欄寬度記進
  `localStorage`(`porthole.chat.listW`,下限 200px),雙擊回預設 280px。
- **綁檔的對話可以改那個檔**:送出時 prompt 前綴一段脈絡區塊 ——
  ```
  [porthole 脈絡]
  repo: <repo>
  開著的檔: <repo 相對路徑>
  你可以直接讀寫這個檔(CWD 已在 repo root)。改完回報:改了什麼 → 為什麼 → 還有什麼沒做。
  ```
  能力本來就有(`--dangerously-skip-permissions` + CWD 受 path-guard);這裡補的是**脈絡 + 明確授權 + 回報格式**。
  邊界不變:寫入面仍由 path-guard 擋在 repo 內,prompt 不是防線。
- **沒綁檔的對話**(對話模式按「新對話」開的)行為與舊版完全相同:`thread-<ts>` → 首輪自動命名成純 slug,
  不寫 link 註記。

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
├── server/                # Fastify:routes(fs / chat / d2)+ lib(claude-p / chat-title / path-guard)
└── web/                   # Vite React:tabs(Explore / Chat)+ theme.ts + DevPick.tsx
```

---

## 7. 驗收標準

1. `npm run dev`(或等價)在 localhost:4321 起得來,**檔案 / 對話**兩個模式都可切換、不報錯。
2. repo 選擇器可切 active repo;basePath 映射正確;path guard 擋得住 `../` 逃逸(要有測試)。
3. Explore 能列 active repo 檔案樹、預覽 / 編輯 markdown。
4. Chat 能跟 `claude -p` 一來一回,紀錄寫進 `<repo>/doc/chat/`;跑著的那輪**關掉頁面再回來看得到、停得掉**。
5. 開著某個檔時右側對話 = 該檔的預設對話(檔名後綴對得上、link 註記寫得進去);對話模式能列出全部對話,
   「新對話」開出來的不綁檔。
6. 視覺:色票全部出自 `theme.ts` 的 `PALETTE`,畫面上沒有殘留的亮色硬編碼(`#fff` / `#f0f0f0` / `#001529`)。
7. DevPick:Ctrl+F12 可 pick 並複製定位器(含 http fallback)。

## 8. 非目標(MVP 不做)

- 多使用者 / 認證(單機自用)。
- 任何會動真錢 / 部署 / 改外部系統的動作。

---

## 9. 細設定案(BDA 提案,待 Kelp/Kirin 驗收)

### 9.1 ~~Session tab~~(2026-10-25 退場)

Session / CLI 兩個 Tab 連同 `node-pty` / `xterm.js` / tmux 生命週期 / WS(`/ws/cli`、`/ws/tmux`)全部移除。
要互動式終端就開真的終端機(或 tmux);porthole 不再代理 PTY。好處見 §2「攻擊面」:
porthole 從此沒有 RCE 面,也不用再守 CSWSH。

### 9.2 dev / prod 啟動

- **dev**:`tsx watch` 跑 Fastify(4321,REST/SSE)+ Vite dev(5173,proxy `/api` 到 4321)。
  瀏覽器開 `http://127.0.0.1:5173/<repo>`。
- **prod**:`vite build` → `web/dist`;Fastify serve dist(含 SPA fallback,非 `/api` 回 `index.html`)+ API,單 port 4321。瀏覽器開 `http://127.0.0.1:4321/<repo>`。
- 詳見 `RUN.md`。

### 9.3 Chat thread 檔名與格式

- 位置:`<repo>/doc/chat/<thread>.md`。`<thread>` 收斂為 `[A-Za-z0-9_-]`(≤96 字,`safeThread`;
  自動命名另經 `slugify` → kebab-case),空則 `default`,再經 path-guard 二次把關(寫入面只允許
  `doc/chat/`)。**不收中文檔名**(跨工具 / URL 風險),中文走檔首 H1 顯示標題。
- 綁檔的 thread 檔名為 `<slug>-<file>-<hex12>`(§4.2.1),故上限從 64 放寬到 96。
- 格式(由上而下):
  ```markdown
  # <顯示標題>                                  ← 可中文,可省(舊檔沒有)
  <!-- porthole:link doc/note/foo.md -->        ← 僅綁檔的 thread 有

  ## 🧑 Human · <ISO>

  …

  ## 🤖 Assistant · <ISO>

  …
  ```
  human / assistant 輪流 append。舊檔無 H1 / 無 link 亦合法(列表回 `title: null` / `link: null`)。
  前端 `parseThread` 以 `## 🧑/🤖` 切 turn,檔首的 H1 與 link 註記自然被略過。

---

*porthole 存在的意義:把跟 agent 溝通從「敲 CLI」變成「開一扇窗」。*
