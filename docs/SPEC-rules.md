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
