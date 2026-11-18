# LocalMonkey v5 — 站台改造規則

> 2026-11-18。前四份仍有效：`SPEC.md`(v1 代理) / `SPEC-console.md`(v2 控制台) / `SPEC-dashboard.md`(v3 儀表板) / `SPEC-translate.md`(v4 翻譯)。
> 這份加的是**使用者自訂的改造規則**：隱藏元素、改寫文字。

---

## 0. 為什麼需要新的一層

翻譯做完之後，使用者的下一批需求是「這個按鈕拿掉」「這段文字改成別的」。

這些**不該用 userscript 做**（會閃、要寫 JS、每個站都要重寫一支），也不該寫死在程式碼裡。它們是**每個站一組、可以在控制台編輯的資料**。

---

## 1. 規則型別（只有三種，刻意保持少）

| 型別 | 怎麼實作 | 用在哪 |
|---|---|---|
| `hide` | 注入 CSS `display: none !important` | 拿掉看得到的東西（按鈕、連結、區塊） |
| `text-replace` | 文字段的字串/正則取代 | `templatemo` → `templatee` |
| `text-rewrite` | 文字段的 pattern → template | `634 燈河` → `燈河[634]` |

### 為什麼「拿掉」用 CSS 隱藏，不用伺服器端刪除

1. **選擇器由瀏覽器比對**，精準。伺服器端沒有 DOM，要刪就得用正則，很容易刪錯或刪不乾淨。
2. **零風險**：規則寫錯最多是沒生效或藏錯東西，不會把 HTML 結構弄壞。
3. 對連結/按鈕來說，「藏起來」和「刪掉」在使用者眼中沒有差別。

**唯一的例外是第三方 `<script>`** —— CSS 藏不掉（藏的是視覺，script 照跑），而且它們是絕對網址、不經過代理所以攔不到。那種要伺服器端從 HTML 刪。**這一期不做**，等真的要擋追蹤再說。

### 執行順序（很重要）

```
上游 HTML → charset → 切段 → 翻譯查快取 → 回填
          → text-replace / text-rewrite 套用在「翻譯後」的文字
          → 注入 hide 規則的 CSS（document-start，零閃爍）
          → 送出
```

- 文字規則套用在**翻譯之後**。所以 `templatemo → templatee` 不會被翻譯快取汙染，改規則立刻生效、不用重翻。
- **文字規則只作用在切段切出來的文字段**，不准碰 `href`/`src`/`class`/`id`/屬性值。

---

## 2. 資料模型

```
site_rules
  id          TEXT PRIMARY KEY
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE
  kind        TEXT NOT NULL      -- 'hide' | 'text-replace' | 'text-rewrite'
  pattern     TEXT NOT NULL      -- hide: CSS 選擇器；text-*: 字串或 /正則/
  replacement TEXT               -- text-* 用；hide 不用
  note        TEXT               -- 給人看的說明
  enabled     INTEGER NOT NULL DEFAULT 1
  order_index INTEGER NOT NULL DEFAULT 0
  created_at  TEXT NOT NULL
  updated_at  TEXT NOT NULL
```

- `text-replace` 的 `pattern` 是**字面字串**（最常見、最安全）
- `text-rewrite` 的 `pattern` 是正則、`replacement` 支援 `$1`…`$9`
- 正則要有保護：編譯失敗 → 規則停用並在 UI 標紅；**加上執行時間上限**防 catastrophic backtracking

---

## 3. templatemo 的具體規則（本期驗收標準）

以下是使用者實際要求的，實作完要能一條一條對照檢查。

### 3.1 首頁 header（圖 8）

使用者已確認：標語改成一句新的描述，不是拿掉。

| 做什麼 | 規則 |
|---|---|
| 標語改成「超級齊全的 HTML CSS 網站模板」 | `text-replace`：`免費 HTML CSS 網站模板` → `超級齊全的 HTML CSS 網站模板` |
| 右邊四顆按鈕全部拿掉 | `hide`：`.tm-menu`（整個容器藏掉即可） |

實測到的 HTML：
```html
<div class="templatemo-logo">
  <a href="/p/templatemo-com/"><img src="/p/templatemo-com/images/templatemo-logo-new.png"
     alt=" templatemo 免費 CSS 模板" title="templatemo - 免費模板" width="280" height="60" /></a>
  <h2 class="templatemo-slogan"> 免費 HTML CSS 網站模板</h2>
</div>
<div class="tm-menu">
  <a href="/p/templatemo-com/page/1">免費模版</a>
  <a href="https://www.tooplate.com" rel="sponsored">HTML 模版</a>
  <a href="/p/templatemo-com/links">連結</a>
  <a href="/p/templatemo-com/contact">聯絡我們</a>
</div>
```

> 標語前面有一個半形空白（`> 免費 HTML...`），`text-replace` 比對時要容忍前後空白，
> 否則字面比對會不中。這是實測看到的，不是假設。

### 3.2 模板卡片標題（圖 6）

把 `634 燈河` 改成 `燈河[634]`。

```
kind:        text-rewrite
pattern:     ^(\d{2,4})\s+(.+)$
replacement: $2[$1]
```

⚠️ 這條只能套在卡片標題那種段落上，**不能全站套**（別的地方可能有「2026 年」之類開頭是數字的句子）。
→ 所以 `text-rewrite` 要支援**限定選擇器範圍**（多一個 `scope` 欄位，只對該選擇器內的文字段生效）。沒有 scope 就是全站。

### 3.3 詳情頁按鈕（圖 4）

只留**下載**與**預覽**，其餘拿掉；而且「實時預覽」要改成「預覽」。

| 按鈕 | 處理 |
|---|---|
| 實時預覽 | 留著，文字改成「預覽」 |
| 下載 | 留著 |
| 全尺寸截圖 | 拿掉 |
| 聯絡表單 PHP 腳本 | 拿掉 |
| HTML 模版（tooplate 廣告） | 拿掉 |
| 您的計時器（timermo 廣告） | 拿掉 |
| AI 網站提示生成器 | 拿掉 |

實測到的選擇器：
```
留：  a#tm-view                                   （實時預覽）
留：  a[href*="/download/"]                       （下載）
藏：  a[href*="/screenshots/"]                    （全尺寸截圖）
藏：  a[href*="ltcclock.com"]                     （聯絡表單 PHP 腳本）
藏：  a[href*="tooplate.com"]                     （HTML 模版）
藏：  a[href*="timermo.com"]                      （您的計時器）
藏：  a[href*="ai-website-prompt-generator"]      （AI 網站提示生成器）
```

文字改寫：`text-replace`　`實時預覽` → `預覽`

> ⛔ **實測到的地雷**：那頁有**兩個元素共用 `id="tm-download"`** —— 真正的下載按鈕，以及「AI 網站提示生成器」。
> HTML 不合法，但瀏覽器的 CSS `#tm-download` 會**兩個都命中**。
> 所以下載按鈕不能用 `#tm-download` 當選擇器，要用 `a[href*="/download/"]`；
> 要藏的 AI 那顆也不能用 id，要用 `a[href*="ai-website-prompt-generator"]`。

### 3.4 Footer（圖 7）

拿掉：關於、隱私政策、聯絡我們、XML 網站地圖、在線計時器。保留版權與年份那段文字。

實測到的 HTML：
```html
<div id="footer">&copy; 2026 <a href="https://templatemo.com">TemplateMo</a>
 - 自2008年起提供免費HTML CSS網站模板
 - <a href="/p/templatemo-com/about">關於</a>
 - <a href="/p/templatemo-com/privacy-policy">隱私政策</a>
 - <a href="/p/templatemo-com/contact">聯絡我們</a>
 - <a href="/p/templatemo-com/sitemap.xml">XML 網站地圖</a>
 - <a href="https://timermo.com">在線計時器</a>
</div>
```

```
hide: #footer a[href*="/about"]
hide: #footer a[href*="/privacy-policy"]
hide: #footer a[href*="/contact"]
hide: #footer a[href*="sitemap"]
hide: #footer a[href*="timermo.com"]
```

> ⚠️ 連結之間的 ` - ` 分隔符是**純文字節點**，CSS 藏不掉。藏完會剩下一排孤兒的 `-`。
> 解法：footer 另外加一條 `text-replace` 把多餘的分隔符收掉，或者直接 `hide` 整個 `#footer` 再用
> `text-replace` 重建。**實作時要真的看畫面**，不要藏完就說做好了。

### 3.5 全站文字替換

```
kind:    text-replace
pattern: templatemo
→        templatee
```

大小寫要分開處理：`templatemo` / `TemplateMo` / `TEMPLATEMO` 都要命中，而且**各自保持原本的大小寫風格**（`TemplateMo` → `Templatee`）。

> ⛔ **但最顯眼的那個 `templatemo` 換不掉 —— 它是一張 PNG。**
> 實測：`<img src="/images/templatemo-logo-new.png" width="280" height="60">`。
> 文字替換對圖片無效，所以只做 §3.5 的話，使用者會看到「內文都改了、左上角那個最大的還是舊的」。
> 這就是為什麼 §3.6 的資源覆寫必須跟這期一起做。

### 3.6 資源覆寫（換 logo / 換圖）

per-site 的一張映射表：**上游路徑 → 使用者上傳的檔案**。瀏覽器來要那個路徑時，
代理不去上游拿，直接回使用者的檔案。

```
resource_overrides
  id          TEXT PRIMARY KEY
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE
  path        TEXT NOT NULL          -- 上游路徑，例 /images/templatemo-logo-new.png
  sha256      TEXT NOT NULL          -- 指向既有的 assets 表（內容定址，已經在用了）
  content_type TEXT NOT NULL
  enabled     INTEGER NOT NULL DEFAULT 1
  created_at  TEXT NOT NULL
  UNIQUE(site_id, path)
```

**為什麼在請求層做，不在 DOM 改 `img.src`**：
DOM 改法會閃（原圖先出現）、漏掉 CSS `background-image`、漏掉 `srcset`、漏掉 JS 動態插入的。
請求層覆寫則是 HTML 完全不用動，所有引用那個路徑的地方一次全換。

上傳走既有的 `assets` 表（內容定址），**要過大小上限與 content-type 白名單**
（只收 image/*，`svg+xml` 要特別小心 —— SVG 可以內嵌 script，從我們自己的 origin 送出去
等於給它一個同源頁面。**本期只收點陣圖，SVG 一律拒絕**，理由寫進 UI）。

控制台 UI：
- 網站分頁 → 「資源覆寫」區塊 → 一列一條：上游路徑、縮圖、換掉 / 停用 / 刪除
- **自動列出候選**：代理掃 HTML 時順便收集 `<img src>`、`srcset`、CSS `url()`，
  在 UI 列出「這個站載過哪些圖」附縮圖，點一下就能換 —— 不要逼使用者自己開 DevTools 抄路徑

本期驗收只要求：能把 `/images/templatemo-logo-new.png` 換成使用者給的檔案，
而且首頁與詳情頁都生效。

---

## 4. 控制台 UI

網站分頁展開 → 「改造規則」區塊：

- 一條一列：型別、pattern、replacement、scope、備註、啟用開關、刪除
- **「試一下」按鈕**：對該站首頁跑一次，顯示會命中幾個元素 / 幾段文字。寫規則最怕的是「寫了沒反應」，要讓人立刻看到有沒有中
- 正則編譯失敗 → 該列標紅並說明原因
- 順序可調（`order_index`）

---

## 5. 這次順便要修的兩件事

### 5.1 快取裡有 6 段簡體（實測）

142 段裡 6 段含簡體字：`灯笼河`、`动感`、`幻灯片`。
v4 的 prompt 已經加了「禁止簡體」，但**這些是加之前翻的，還在快取裡**。

- 加一個「掃出快取裡的簡體段」的功能，列在翻譯分頁，可以一鍵全部重翻
- **簡體偵測不要自己手寫字元清單**（我手寫的那份漏了「灯」「笼」「动」，所以第一次掃出 0 段是假的）。
  用成套的簡繁對照表，或至少把常見簡體字收齊並寫成一個有測試的模組

### 5.2 「第一次造訪看到英文」不是 bug，但要讓人知道

使用者反映「這邊怎麼沒翻譯到」（圖 5），實際上那是 v4 的設計行為：第一次造訪先給原文、背景翻譯、下次才是中文。查證後那段現在已經是中文了。

但從使用者角度這就是「壞了」。要做的是讓它不要發生或至少看得懂：

- 控制台的站台設定，把「**預先翻譯整站**」做得更顯眼（這個功能已經有了，就是為了解決這件事）
- 代理回應加一個 header（例如 `x-lm-translate: 12/85`）給人除錯用
- （可選）頁面右下角一個小角標顯示「翻譯中 12/85」，翻完自動消失

---

## 6. 測試

- 三種規則各自的純函式測試（命中、不命中、停用、順序）
- `text-replace` **不准碰屬性**：`href="https://templatemo.com"` 裡的 `templatemo` 不可以被換掉（這條是防止過度修正的回歸保護）
- 大小寫保持：`TemplateMo` → `Templatee`
- `text-rewrite` 的 scope 限定：只對該選擇器內的段生效
- 正則編譯失敗 → 規則停用、不影響其他規則、不讓代理 500
- 正則執行逾時 → 中止該規則，代理照常回應
- `hide` 產生的 CSS 注入在 `document-start`、選擇器有正確轉義
- **templatemo 的整組規則**跑一次，逐條對照 §3 的表
- 既有 1037 條全綠

---

## 7. 完成的定義

1. `npm test` 全綠、覆蓋率 ≥80%，貼實際輸出
2. **真的用瀏覽器開這三頁**，逐條對照 §3 並截圖：
   - 首頁：標語變成「超級齊全的 HTML CSS 網站模板」、`.tm-menu` 四顆按鈕沒了、卡片標題是 `燈河[634]` 格式
   - 詳情頁 `tm-634-lantern-river`：只剩「預覽」和「下載」兩顆
   - Footer：五個連結沒了，**而且沒有留下孤兒的 `-` 分隔符**
   - 全站 `templatemo` → `templatee`，但 `href` 沒被動到
   - **資源覆寫**：換一張圖上去，首頁與詳情頁的 logo 都變成新的（§3.6）
3. 快取裡的 6 段簡體重翻完，用**有測試的**簡體偵測確認是 0
4. commit + push

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，不准任何 Claude / Co-Authored-By 署名。

---

# 第二輪（2026-11-18）

> 前面 §0~§7 是第一輪，全部仍然有效。這一節加的是：**換了資源看不到**的解法、
> 新的 `css` 規則型別，以及 templatemo 的四條新規則。

---

## 8. ⛔ 換了資源看不到（這一輪優先度最高）

### 8.0 現況（實測，不是推論）

| | cache-control |
|---|---|
| HTML | `no-store` ✅（第一輪修的） |
| 規則 CSS（inline `<style id="lm-site-rules">`） | 跟著 HTML ✅ |
| CSS 檔 | `max-age=86400`（照抄上游） |
| **圖片** | **`max-age=604800`（7 天，照抄上游）** |

所以 §3.6 的資源覆寫**實際上是不能用的**：換了 logo，使用者**七天內看不到**，
而且**伺服器端完全看不出症狀** —— `curl` 永遠拿到新的那張，因為 curl 沒有快取。

這是地雷 33 / 46 的第三個變體。非 HTML 照抄上游快取是**對的**（那是代理速度的
唯一來源），所以解法不能是「全部關掉快取」。

### 8.1 內容雜湊 cache busting（預設開，沒有開關）

HTML 已經是 `no-store`，所以改寫 HTML 是安全的 —— 給**有覆寫的那些路徑**加上
內容雜湊：

```
/p/<site>/images/logo.png   →   /p/<site>/images/logo.png?v=<sha256 前 8 碼>
```

- 換圖 → sha 變 → 網址變 → 瀏覽器**根本不會碰到**舊快取那一筆，不用 Ctrl+F5
- 那個新網址可以放心長快取：`?v=` 對得上時覆寫回 `public, max-age=31536000, immutable`
- **只對有覆寫的路徑加**。沒覆寫的資源一個都不碰（不然等於把整站快取關掉）

處理的引用點：`src`、`poster`、`srcset`（多個網址 + 描述符）、`<link href>`、
`url()`（inline style 與頁面裡的 `<style>` 區塊）。

⛔ **`<a href>` 刻意不處理** —— 那是導航不是子資源。

⛔ **`url()` 裡的網址沒有 `/p/<site>/` 前綴**，所以 busting 要認兩種形狀：
代理改寫過的 `/p/<site>/…`，以及**沒被改寫的根絕對路徑** `/images/logo.png`
（`lib/html.js` 只改 `src`/`href`/`action`/`poster`/`formaction`，不動 `url()`，
那條路徑是由根路徑 fallback 接住的）。少了第二種，`background-image` 的 logo
就永遠拿不到版本號 —— 而那正是換圖最常漏掉的地方。

⛔ **分隔符用裸的 `&` 不是 `&amp;`**：同一支函式要改寫兩種上下文 ——
屬性值（entity 會被解碼）與 `<style>` 裡的 `url()`（raw text，**不會**解碼）。
寫 `&amp;` 的話 CSS 那邊會去要一條含 `&amp;` 的網址 → 404，而且症狀只出現在
background-image 上。

實作：`src/lib/cache-bust.js`、`src/proxy/resource-override.js`。

### 8.2 碰不到的邊界，與開發模式

`?v=` 只救得了「**HTML 裡有引用那條路徑**」的資源。只被**外部 CSS 檔**的
`background-image: url()` 引用的圖拿不到版本號 —— 那個網址寫在 CSS 檔裡，而
CSS 檔自己也被瀏覽器快取著。這個邊界沒有辦法用改寫 HTML 解決。

所以多一個 per-site 的 **`dev_mode`（預設關）**：

- 打開時**所有**代理回應都 `cache-control: no-cache`，但**保留 ETag 與
  Last-Modified** —— `no-cache` 是「每次先問過」不是「不要快取」，304 不傳 body，
  revalidate 很便宜
- 丟掉舊式的 `expires` / `age` / `pragma`（它們會讓瀏覽器自己算出「不用問」）
- HTML 不走這條：它已經是 `no-store`（更強），而且 HTML 的 ETag 一定要丟掉
  （304 沒有 body，我們就沒得改寫 → 瀏覽器會拿**沒改寫過**的舊副本出來用）

控制台在「改造規則」區塊最上面有這個開關，文案把代價講清楚：
**會慢一點，但改什麼都立即生效** —— 反覆調規則時打開，調完關掉。

---

## 9. 新規則型別 `css`：注入任意 CSS

`hide` 其實是 `css` 的特例（它產生的就是 `選擇器 { display: none !important }`）。

| | `hide` | `css` |
|---|---|---|
| `pattern` 存什麼 | 一個 CSS 選擇器 | **一整段 CSS 文字** |
| UI | 單行輸入 | **textarea** |
| 命中數 | 瀏覽器用 `querySelectorAll` 數得出來 | 沒有「命中數」這個概念（回 `null`） |
| 什麼時候用 | 把一個東西藏起來 | 改間距、畫 `::before`、覆蓋前面某條規則 |

兩種都留著：`hide` 不用懂 CSS，而且控制台數得出它中幾個元素。

**跟 `hide` 合進同一個 `<style id="lm-site-rules">`，順序照 `order_index`** ——
那是語意不是美觀：兩條都帶 `!important` 時**後面的勝**，所以 `css` 規則要能
覆蓋前面某條 `hide`（先藏整個容器、再把其中一塊放回來）。

### 9.1 ⛔ 防注入

使用者寫的字會**原樣**進我們注入的 `<style>`，而 `<style>` 的內容對 HTML
分詞器來說是 raw text —— 唯一的出口是 `</style`。擋掉它就擋掉整類攻擊：

- 大小寫不分（`</STYLE>`、`</Style>`）
- 空白的變形要擋（`</style   >`、`</style/`、`</style\t>`）
- `</` 與標籤名之間的空白也擋（分詞器其實不吃，但不猜它的脾氣）

跟 `rules/selector.js` 不一樣的三件事，每一件都有理由：

1. **`{` `}` `;` 放行** —— CSS 沒有它們就不是 CSS。選擇器擋它們是因為那裡多一個
   `}` 就等於多一條規則；這裡使用者本來就有權寫任意規則。
2. **`\` 放行** —— CSS 的跳脫序列是正常寫法，而 `<\/style>` 在分詞器眼裡**不是**
   結束標籤（它看到的是 `<` 接 `\`）。
3. **換行放行**，所以跳脫非 ASCII 時**不能**沿用 `escapeCssNonAscii` ——
   它擋的是 `[^\x20-\x7e]`，那個範圍含 `\n` / `\t`，多行 CSS 會被寫成
   `.a {\00000a  margin: 0;}`，整份報廢。

**驗證層刻意收得下壞規則**（跟編不過的正則同一個待遇，§4：UI 要標紅說明原因）
—— 防線在編譯那一側，壞的那條不會進注入的 `<style>`。

實作：`src/rules/css-text.js`。有退化驗證（拿掉 `</style` 檢查，10 條測試變紅）。

---

## 10. templatemo 的四條新規則

### 10.1 logo 換成 templatee（用 CSS，不用圖）

使用者沒給圖，所以用 CSS 畫：藏掉 `.templatemo-logo img`，在 `<a>` 上用
`::before` / `::after` 疊出字樣。

**顏色與尺寸都是從原圖量出來的，不是挑的**（`System.Drawing` 掃
`templatemo-logo-new.png`）：

| 量到的 | 值 |
|---|---|
| 白字 | `#FFFFFF`（1877 px） |
| `mo` 的螢光黃綠 | `#CCFF00`（593 px） |
| 圖的尺寸 | 280×60 |
| 字的 ink box | x 8..268、y 8..51（寬 **261**、高 44） |

`font-size: 54px` 也是量的 —— 在真瀏覽器上量 Raleway 700 的 `templatee`：
44px→211、46px→221、48px→231、50px→241、52px→251、**54px→261**，剛好等於
原 logo 的 ink 寬度。

⛔ `font-weight` 用 **700 不是 800**：原站只從 Google Fonts 載 Raleway
300/400/500/600/700，寫 800 會變成瀏覽器自己合成的假粗體。

### 10.2 ⛔ 多餘的空白：原本的診斷是錯的

一開始的假設是「`display: none` 只藏元素，**容器的高度與 margin 還在**」。
**量完發現不是那樣**：`.tm-dl-grey` / `.tm-dl-grey-premium` 這些容器的子元素
都是 float，所以它們本來就是 0 高，藏掉子元素不留空間。

真正的空白是兩個**從來沒被填滿的廣告位**：`.tm_banner` 自己帶
`min-height: 300px`，而廣告腳本是絕對網址（googlesyndication 等）、不經過代理
也載不起來 → 永遠是 300px 的純白。**首頁與詳情頁各兩個 ＝ 600px。**

實測（1920×911 的真瀏覽器）：

| | 修之前 | 修之後 |
|---|---|---|
| 首頁 hero → 第一排卡片 | 380px | **80px** |
| 首頁整頁高度 | 3733px | **3073px** |
| 詳情頁整頁高度 | 5029px | **4395px** |
| 高度 ≥ 40px 的空區塊 | 2 個 | **0 個** |

順便收掉「分享按鈕藏掉之後，只為了隔開它而存在的那條 60px 間隔條」——
**那一條才是原本假設講的那種情況**。

### 10.3 詳情頁那段英文樣板文

```
Lantern River Template is 100% free to download for anyone. You are allowed to…
```

每個模板一句、名字內嵌，600+ 個模板就是 600+ 段。

```
hide: #tm-dl-box p:has(> a[href*="templatemo.com/tm-"])
```

⛔ **為什麼不用 `#tm-dl-box p:nth-of-type(2)`**：那靠「Tags 那段一定在」，而那是
假設。`:has()` 這條是**內容定位**的 —— 它就是「直接連回這個模板自己」的那一段
（實測 tm-628 與 tm-634 的 `#tm-dl-box` 裡只有這個 `<p>` 有這種直接子連結；
breadcrumb 那個是 `h2`）。代理不改寫絕對網址，所以 `templatemo.com/tm-` 在送出去
的 HTML 裡還在。

⛔ **藏掉**並**不會**省下翻譯：那段文字仍然在 HTML 裡 → 切段器照樣切到它 →
照樣進翻譯佇列。CSS 藏的是視覺，而翻譯層在規則層**之前**跑（§1 的執行順序，
那個順序是為了「改規則立刻生效、不用重翻」）。要真的省下模型時間得有一個
「這些段不要翻」的規則型別，這一期沒做。

順便把使用者自己在控制台加的兩條 `hide` 收進 preset（`.sharethis-inline-share-buttons`
與 `.tm-dl-grey-premium`），這樣重跑 seed 不會把它們弄丟。

### 10.4 ⛔ `Added:` / `Views:` / `Downloads:` 要翻譯：根因不在模型

症狀：這三個標籤永遠是英文，而**同一行的日期翻好了** —— 看起來像「模型漏翻了
這幾個字」。

根因在**切段規則**，不在模型也不在快取：`translate/rules.js` 的「整段看起來是
網址」判斷寫成 `^[a-z][a-z0-9+.-]*:`，於是 **`Added:` 被認成一個 URL scheme**，
`isTranslatable` 回 false → 這三段**從來沒進過佇列**。`Tags:` 也一樣。

修法是要求 scheme 後面**至少有一個非空白字元**（真的 scheme 後面必有內容：
`http://x`、`mailto:a@b`、`data:image/png`）：

```js
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\S|\/\/|www\.)/i;
```

實機跑真 ollama 確認：`新增日期：` / `觀看次數：` / `下載：` / `標籤：`。
有退化驗證（改回舊的正則，3 條測試變紅）。

---

## 11. preset 的身分問題（實作時踩到的）

`applyPreset` 原本用 `kind + pattern` 當「同一條規則」的 key。對 `css` 型別那是
錯的 —— **`css` 的 pattern 就是被編輯的內容本身**。把 logo 的 `font-size` 從
46px 調成 54px 再重跑 seed，結果不是「更新一條」而是「**新增一條**」：
兩條同時注入，誰贏看 `order_index`，而舊的那條還活著。

所以 `css` 規則的身分改用 `note`（那才是它的穩定標籤），而且 `applyPreset`
現在也會把 `pattern` 寫回去。有一條回歸測試釘著。

---

# 第三輪（2026-11-18）

> §0~§11 全部仍然有效。這一節加的是 §10.3 自己留下的那筆帳：
> **藏掉不等於不翻**。

---

## 12. 新規則型別 `no-translate`：這些段不要翻

§10.3 用 `hide` 把詳情頁那段英文樣板文藏掉了，並且在結尾寫下：

> ⛔ **藏掉**並**不會**省下翻譯：那段文字仍然在 HTML 裡 → 切段器照樣切到它 →
> 照樣進翻譯佇列。（…）要真的省下模型時間得有一個「這些段不要翻」的規則型別，
> 這一期沒做。

這一期做了。

| | `hide` | `no-translate` |
|---|---|---|
| 改的是 | 看得到的東西 | **哪些段要餵給模型** |
| 作用在 | 瀏覽器（注入 CSS） | 伺服器端的切段結果 |
| `pattern` | CSS 選擇器 | **文字比對**（見 §12.1） |
| 省下模型時間 | **沒有** | 有 |

兩個是**互補**的，不是替代：樣板文那一段兩條都要配（一條管看不到、一條管不要翻）。

### 12.1 ⛔ `pattern` 是文字比對，不是選擇器

直覺上這個型別應該長得像 `hide`（給一個選擇器，裡面的都不翻）。**在這個站上做不到**：

1. **伺服器端沒有 DOM。** 唯一的選擇器比對器是 `rules/scope.js`，而它只看得懂
   「祖先鏈就能判斷」的子集（`tag` / `.class` / `#id` / `*` ＋ 空白與 `>` 組合子）。
   `:has()`、`:nth-of-type()`、`[attr]` 一律**拒絕**而不是忽略 —— 忽略等於
   「規則悄悄套到全站」。
2. **那段樣板文的容器是 `#tm-dl-box p`，而 `Tags:` / `Added:` / `Views:` /
   `Downloads:` 跟它同一個容器** —— §10.4 才剛修好讓那三個標籤進得了佇列。
   所以「用範圍圈出那一段」會把剛修好的東西又關掉。

而「那句話長什麼樣」是確定的。所以：

```
pattern: is 100% free to download for anyone      ← 字面子字串（空白寬鬆、不分大小寫）
pattern: /^\d{2,4} /                              ← /正則/（跟 text-rewrite 同一套保護）
pattern: *  +  scope: .ad                         ← 整個範圍內全部不翻
scope:   選用，收窄用的（跟文字規則同一套，同樣的限制）
```

三種模式都是**沿用既有的編譯器**（`literal.js` / `user-regex.js` / `scope.js`），
這個型別沒有自己的語法。

⛔ **`*` 一定要配 `scope`**，不然編譯失敗並標紅。沒有 scope 的 `*` ＝「這個站一段
都不要翻」，而那個意思應該用站台設定的翻譯開關表達 —— 一條規則能靜默關掉整站的
翻譯是很糟的 footgun：使用者會去查 ollama，而真因是控制台裡的一條規則。

### 12.2 篩在哪裡（兩條路徑都要接）

```
collectSegments() → isTranslatable() 濾完 → ⬅ no-translate 在這裡篩
                 → 查快取 / 進佇列
```

**篩在 `isTranslatable` 之後**，所以「省下 N 段」的 N 是真的省下來的工作量，
不是「掃過幾段」。本來就不會翻的段（太短 / 純數字 / 已經是中文）不算。

⛔ **翻譯層與爬蟲是兩條路徑，都要接**（`rules/no-translate.js` 的
`collectTranslatable()` 是唯一的入口）。少接爬蟲那一邊的後果是：頁面上省掉了，
但使用者按一次「預先翻譯整站」又把那 600 段全部塞回佇列。

這也是**規則層唯一一隻伸進翻譯層的手**。執行順序（§1）沒有改 ——
翻譯仍然跑在規則層之前，`no-translate` 只是在切段的時候多問一句。

### 12.3 看得到省了多少

- 代理回應：`x-lm-translate: 12/81 no-translate=1`（有規則才附上後面那段）
- 控制台「試一下」：那一列顯示**「省下 N 段」**（不是「命中 N」—— 意思不一樣）
- 控制台數的是**還沒翻的**段。`no-translate` 擋下來的段永遠不會變成中文，
  所以該數到的都數得到

### 12.4 templatemo 的規則（實測數字）

```
kind:    no-translate
pattern: is 100% free to download for anyone
```

`tests/fixtures/templatemo/tm-634-lantern-river.html`（2026-11-18 真的抓下來那份）：

| | 加規則前 | 加規則後 |
|---|---|---|
| 進佇列的段數 | 82 | **81** |
| 去重後的原文數 | 64 | **63** |
| 字元數 | 3452 | **3230**（−222，−6.4%） |
| 首頁 / `/page/1` | 112 / 107 | **112 / 107**（一段都沒誤傷） |

擋掉的那一段是**全頁第四長**、也是最長的「沒有人看得到」的段。單頁看起來只差
一段，但那句話**名字是內嵌的** → 600+ 個模板頁就是 600+ 筆不同的快取 key，
每筆 222 字（全頁平均 42 字的五倍）。

⛔ **同一個 `<p>` 的前半段刻意不擋。** 那個 `<p>` 在切段器眼裡是兩段（中間隔著
一個 `<a>`），前半是 `<模板名> Template`。量過了：同一個字串也是頁面上看得到的
`<h1 class="title">`，而佇列是按**去重後的原文**翻的 → 擋它會讓「省下 N 段」
從 1 變成 2，**而模型的工作量一模一樣**。
這是這一輪唯一真正的誘惑：一個讓數字變好看、但什麼都沒省到的規則。

### 12.5 DB

`site_rules.kind` 的 CHECK 要多一個值，而 SQLite 不能 ALTER 掉 CHECK ——
所以 **v7 又重建了一次整張 `site_rules`**（順序同 v6，照地雷 11：
rename → 建新表 → 複製 → DROP → 重建 index）。欄位一個都沒變。

實作：`src/rules/no-translate.js`、`src/rules/compile.js`、
`src/translate/pipeline.js`（多一個 `ancestors` 選項）、`src/db/migrations.js`。
