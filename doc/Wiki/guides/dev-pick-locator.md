# DevPick — agent 友善的 UI 元素定位器（Ctrl+F12）

> **跨專案可重用 pattern。** 任何「人在跑 web UI、要叫 AI agent 改某個元素」的專案都適用。
> 解決「怎麼把畫面上的元素**精準指給 agent**」這件事。
> 參考實作：`quant-oak` 的 `ana-web/web/src/DevPick.tsx`（React）。

---

## 問題

人在瀏覽器看到某個按鈕/區塊壞了或想改，要叫 agent 動手時，得先讓 agent **對到原始碼的那個元素**。常見指法都不友善：

| 指法 | 對 agent 友善度 | 為什麼 |
|------|------|------|
| **F12 → Copy XPath** | ❌ 最差 | `//*[@id="root"]/div/div/div[2]/div[1]/div/button` —— agent 得在腦中數 DOM 巢狀對回 JSX，極易數錯 |
| **F12 → Copy selector（CSS）** | 🆗 | 比 XPath 短，可能含 id/class；但前端框架（React 等）產生的 `div:nth-child(2)` 仍脆、不穩定 |
| **口述位置**（「右上那個藍按鈕」） | 🆗 | 模糊、多個相似元素時會猜錯 |
| **元素文字 + 頁面** | ⭐ | agent 用可見文字直接對 JSX，很穩 |
| **`data-loc` 自訂屬性** | ⭐ 最佳 | 我們控制的穩定 ID（如 `t3:anchor`），agent 一眼定位 |

**結論**：做一個 dev-pick 模式，點元素時複製一條**混合定位器** —— 同時帶 `data-loc`（若有）、可見文字、route、短 CSS path。agent 優先用 `data-loc`/文字，CSS 當輔助。

---

## 設計（Ctrl+F12）

1. **Ctrl+F12** 開/關 pick 模式（頂部橫條提示「DEV PICK · Esc 退出」）。
2. pick 模式中：滑鼠 **hover** → 高亮游標下元素（外框）。
3. **click** → 計算混合定位器 → 複製到剪貼簿 + 角落 toast 顯示複製內容 → 自動退出。
4. **Esc** 退出。

> 純前端、零後端。掛在 App 根層即可，正式環境也可留著（dev 工具，不影響使用者，除非按 Ctrl+F12）。

### 混合定位器格式

```
route=/t3  |  data-loc=t3:anchor  |  text="* dig 0 · 59d"  |  tag=label  |  css=div:nth-of-type(3) > ... > label
```

- `route` — 哪一頁（SPA path）
- `data-loc` — 若元素或祖先有此屬性（最穩，optional）
- `text` — 可見文字（截斷 ~48 字）
- `tag` — 元素 tag
- `css` — 短 CSS path（往上最多 5 層，遇 id / data-loc 即停）

人 pick 完直接把這串貼給 agent，agent 就能對到 source。比 F12 任何單一選項都好用。

---

## 參考實作重點（React，框架無關概念）

完整見 `quant-oak/ana-web/web/src/DevPick.tsx`。關鍵：

```tsx
// 1. 短 CSS path：往上最多 5 層，遇 id / data-loc 即停
function cssPath(start) {
  const parts = []; let node = start; let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    if (node.id) { parts.unshift('#' + node.id); break; }
    const dl = node.getAttribute('data-loc');
    if (dl) { parts.unshift(`[data-loc="${dl}"]`); break; }
    let sel = node.tagName.toLowerCase();
    const sibs = [...(node.parentElement?.children ?? [])].filter(c => c.tagName === node.tagName);
    if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    parts.unshift(sel); node = node.parentElement; depth++;
  }
  return parts.join(' > ');
}

// 2. 混合定位器
function buildLoc(el) {
  const route = location.pathname;
  const dl = el.closest('[data-loc]')?.getAttribute('data-loc');
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  return [`route=${route}`, dl && `data-loc=${dl}`, text && `text="${text}"`,
          `tag=${el.tagName.toLowerCase()}`, `css=${cssPath(el)}`].filter(Boolean).join('  |  ');
}

// 3. Ctrl+F12 toggle、hover 高亮、click 複製。click 用 capture + preventDefault
//    擋掉底層元素原本行為（pick copy 按鈕時不會真的觸發 copy）。
```

### 兩個踩雷

1. **剪貼簿在 http 失效** —— `navigator.clipboard` 只在**安全上下文**（https 或 localhost）存在。
   區網/Tailscale 用 `http://` 開時它是 `undefined`。要 fallback：
   ```js
   function copyText(text) {
     if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
     // fallback：textarea + document.execCommand('copy')
   }
   ```
2. **click 要 capture + preventDefault + stopPropagation**，否則點到按鈕會觸發它原本的行為。

---

## 進階：`data-loc` 穩定標籤

要 agent 一眼定位，在關鍵互動元素加自訂屬性（命名建議 `頁面:元件:角色`）：

```tsx
<button data-loc="t3:ngp:togglePoint">Toggle Point</button>
```

pick 出來就是 `data-loc=t3:ngp:togglePoint`，agent 直接對到。不必全加，挑常被指的元素逐步補。

---

## 採用建議

- **任何 SPA / 多頁 web** 都可移植：核心是「全域 keydown 監聽 + hover 高亮 + click 算定位器 + 剪貼簿」，與框架無關（React/Vue/Svelte/原生皆可）。
- 鍵位 `Ctrl+F12` 若被 OS/瀏覽器佔用可換（如 `Ctrl+Shift+P`）。
- 正式環境留著無妨（隱藏功能）；要保險可用 env / build flag gate 在 dev only。

> 來源：quant-oak `ana-web`（T3 Viewer / Backtest web）。2026-06 由 Kirin + agent 在迭代中發明，
> 因為「人用 web、agent 改 code」的回饋迴圈需要一個穩定的 UI 指法。
