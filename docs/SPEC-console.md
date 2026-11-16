# LocalMonkey v2 — 油猴腳本控制台

> 2026-11-16 定案。這份是 v2 的實作契約，`docs/SPEC.md` 是 v1（代理核心，仍然有效）。
> v1 的代理、SSRF、認證、注入機制**不要動**，這份只改「使用者怎麼餵腳本進去」與後台長相。

---

## 0. 一句話

**把 Tampermonkey 的主控台搬過來**：左邊一排腳本、右邊一個真的編輯器。丟一支 `.user.js` 進去，它自己讀 header 判斷要配哪些網域、自己建站、自己掛上去。

使用者原話：「基本上就是控制台，然後就很像 Zed 或 VSCode 那種編輯器而已」「讓我丟油猴腳本，絕對能判斷啊」。

### v1 後台錯在哪（這就是要改的原因）

1. **站台優先**：要先建站 → 進去 → 才能加腳本。但人的腦袋是腳本優先：丟一支腳本，站台應該自己長出來。
2. **該唯讀的做成輸入框**：名稱、執行時機、match、順序 —— userscript header 裡全都有，叫使用者再手填一次是多餘的，而且會跟 header 打架（兩個真相來源）。
3. **`<textarea>` 不是編輯器**：沒行號、沒高亮、沒括號配對，貼 300 行腳本沒法看。
4. **版面**：固定寬度置中卡片，寬螢幕上兩邊各空一大片。控制台要吃滿寬度、密一點。

---

## 1. 既有決定（不要重新討論）

| 項目 | 決定 |
|---|---|
| 編輯器 | **CodeMirror 5**，單一檔案 vendor 進 `src/public/vendor/`（含 LICENSE）。**不准**引入 build step、不准從 CDN 載 |
| 「網站」分頁 | **留著，但唯讀**。站台由腳本自動建立；這一頁只看代理網址、複製、開啟、停用，以及指定萬用子網域的具體主機 |
| 其餘技術約束 | 同 v1 SPEC §2：Node 24、Express 5、CommonJS、`better-sqlite3` ^12、零依賴、無 build step、`node:test` |

---

## 2. 資料模型（migration，`PRAGMA user_version` 往上加一版，不要改舊版）

v1 的 `scripts.site_id` 是單一外鍵 → 一支腳本配兩個網域就得複製兩份程式碼 → 改一次要改兩個地方 → **「改一次全部生效」這個核心賣點直接破功**。必須改成多對多。

```
scripts                         -- 腳本本體，不再綁單一站台
  id            TEXT PK
  name          TEXT NOT NULL   -- 解析自 @name，解析不到就用檔名/「未命名腳本」
  version       TEXT            -- @version
  description   TEXT
  source        TEXT NOT NULL   -- ★ 原始 .user.js 全文（含 header），這是唯一真相來源
  metadata      TEXT NOT NULL   -- 解析結果 JSON（見 §3）
  run_at        TEXT NOT NULL   -- 'document-start' | 'document-end' | 'document-idle'
  enabled       INTEGER NOT NULL DEFAULT 1
  order_index   INTEGER NOT NULL DEFAULT 0
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL

script_sites                    -- 哪支腳本掛在哪個站、配哪些路徑
  script_id     TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE
  site_id       TEXT NOT NULL REFERENCES sites(id)   ON DELETE CASCADE
  path_glob     TEXT NOT NULL   -- 由 @match 的 path 轉換而來（見 §3.2）
  exclude_glob  TEXT            -- 由 @exclude / @exclude_match 轉換而來，可為 NULL
  PRIMARY KEY (script_id, site_id, path_glob)

assets                          -- @require / @resource 的伺服器端快取
  sha256        TEXT PK
  url           TEXT NOT NULL
  content       BLOB NOT NULL
  content_type  TEXT
  bytes         INTEGER NOT NULL
  fetched_at    TEXT NOT NULL
```

`sites` 沿用 v1，多兩個欄位：
```
  auto_created  INTEGER NOT NULL DEFAULT 0   -- 由腳本自動建立的（UI 標示用）
  from_pattern  TEXT                          -- 來源 @match，萬用子網域時給使用者看
```

**migration 要保住既有資料**：v1 的 `scripts`（有 `site_id` + `match_glob` + `code`）搬進新表 —— `code` 進 `source`、`match_glob` 進 `script_sites.path_glob`、`run_at` 的 `head-end`→`document-start`、`body-end`→`document-end`。要有測試證明舊 DB 升級後資料還在。

---

## 3. Userscript 解析（`src/userscript/`）

### 3.1 Metadata block

抓 `// ==UserScript==` 到 `// ==/UserScript==` 之間的 `// @key value` 行。要支援的 key：

`@name`（含 `@name:zh-TW` 這類 locale 變體，取無 locale 的那個）、`@namespace`、`@version`、`@description`、`@author`、`@match`、`@include`、`@exclude`、`@exclude_match`、`@grant`、`@require`、`@resource`、`@run-at`、`@connect`、`@noframes`、`@icon`

- 同一個 key 可以出現多次（`@match` 最常見）→ 一律收成陣列
- 沒有 metadata block → **不要拒收**。當成「純 JS 片段」，回報「沒有偵測到 UserScript header，要自己指定網域」，走手動路徑
- 解析器是純函式，吃字串吐物件，**不碰 DB、不碰網路**。這樣才測得動

### 3.2 `@match` → （主機, 路徑 glob）

Chrome match pattern 語法：`<scheme>://<host><path>`。

**⛔ 最容易錯的一點**：match pattern 的路徑 `*` **會跨斜線**，但 LocalMonkey v1 的 `match_glob` 單星號**不跨**（`**` 才跨，而單獨一個 `*` 是 match-all 特例）。直接照抄會變成腳本不執行、或到處都執行，**而且不會報錯**。必須做語意轉換：

| @match 路徑 | 轉成 path_glob |
|---|---|
| `/*` | `*`（match-all 特例） |
| `/items/*` | `/items/**` |
| `/a/*/b` | `/a/**/b` |
| `/exact` | `/exact` |

主機部分的分類（這是 UI 要顯示的狀態）：

| 主機樣式 | 狀態 | 行為 |
|---|---|---|
| `www.example.com` | `ready` | 直接建站，target `https://www.example.com` |
| `*.example.com` | `needs-host` | 預設提議 `example.com`，並在 UI 標示「萬用子網域，可在網站分頁加具體主機」 |
| `*` / `<all_urls>` / `*://*/*` | `rejected` | **擋下來**並說明：反向代理必須指向具體主機，配全世界沒有意義 |

scheme：`https` 優先。`*://` 視為 https。`http://` 照收但 UI 要標示不安全。

`@include` 走同一條路但更寬鬆（`*` 可以出現在任何位置）；`/正則/` 形式嘗試抽出字面主機，抽不到就標 `rejected` 並說明原因 —— **不要猜**。

`@exclude` / `@exclude_match` → `script_sites.exclude_glob`，注入判斷時命中就不注入。

### 3.3 `@run-at`

| @run-at | 注入位置 |
|---|---|
| `document-start` | **`<head>` 的第一個子元素**（不是 `</head>` 之前！v1 的 head-end 已經晚於頁面自己的 script，想 hook `fetch` 的腳本會失效） |
| `document-end`（預設） | `</body>` 之前 |
| `document-idle` | `</body>` 之前，外面包 `DOMContentLoaded` + `requestIdleCallback` fallback |

v1 的 `html.js` 要多一個「插在 `<head>` 開頭」的注入點。沒有 `<head>` 的 HTML 要有 fallback。

---

## 4. GM API 支援

### 4.1 前端 shim（`src/public/gm-shim.js`，只在腳本有 `@grant` 且不是 `none` 時注入）

shim 是一支獨立投遞的腳本，排在使用者腳本**之前**。每支使用者腳本拿到自己的 `GM_*`（用 `@grant` 清單決定只暴露哪些，沒 grant 的不要給 —— 跟 Tampermonkey 一致）。

| API | 實作 |
|---|---|
| `unsafeWindow` | `window`（我們本來就在頁面 scope） |
| `GM_addStyle(css)` | 建 `<style>` 塞進 head，回傳該元素 |
| `GM_setValue/getValue/deleteValue/listValues` | `localStorage`，key 前綴 `__lm_gm_<scriptId>_`。同步版本 |
| `GM.setValue/getValue/...`（GM4） | 同上但回 Promise |
| `GM_openInTab(url, opts)` | `window.open` |
| `GM_setClipboard(text)` | `navigator.clipboard.writeText`，失敗回 false 並 warn |
| `GM_registerMenuCommand(name, fn)` | 右下角一顆小浮動按鈕展開選單。樣式要 `all: initial` 隔離，避免被原站 CSS 汙染 |
| `GM_notification` | `Notification` API，沒權限就退回頁面內 toast |
| `GM_info` | 從 metadata 合成 |
| `GM_getResourceText/URL` | 走 `assets` 快取（§4.3） |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | 走伺服器端轉發（§4.2） |

shim 自身任何錯誤都要吞掉 + `console.warn('[LocalMonkey] ...')`，**絕不能弄壞被代理的原站**。

**沒有 shim 的 `@grant`**（例如 `GM_download`、`GM_cookie`）：不要靜默失敗。產生一個會 `console.error` 說明「LocalMonkey 尚未支援 GM_xxx」的 stub，並在後台該腳本的資訊列標示紅字。使用者要知道哪裡會壞。

### 4.2 `GM_xmlhttpRequest` 伺服器端轉發 —— ⛔ 這是安全重點

端點 `POST /__lm/gm/xhr`。它會讓伺服器代替使用者發任意請求，沒鎖好就是**開放代理 + SSRF**（這個專案已經修過一次同類漏洞，見 v1 `src/proxy/forward.js` 的註解）。

必須全部做到：

1. **來源檢查**：`Origin`（或 `Referer`）必須對應到一個已登記且啟用的 site。對不上 → 403
2. **`@connect` 白名單**：目標主機必須命中該腳本 `@connect` 宣告的主機，或等於該 site 自己的 origin。`@connect` 沒宣告 → 只准打 site 自己的 origin。`@connect *` → **拒絕**，並在 UI 說明要列出具體主機
3. **SSRF 防護**：重用 v1 的 `src/lib/ssrf.js`，解析 DNS 擋私網（受 `LOCALMONKEY_ALLOW_PRIVATE` 控制）
4. **method 白名單**：GET/POST/PUT/PATCH/DELETE/HEAD。不轉發 `Host`、`Cookie`（除非腳本明確帶且目標是同 site origin）
5. **大小與時間上限**：回應 10MB、逾時 30s，可用 env 調
6. **不轉發 LocalMonkey 自己的 admin token**；回應 header 過濾掉 `set-cookie`
7. 每個 site 的呼叫做簡單速率限制

回傳 `{ status, statusText, headers, responseText, finalUrl }`，shim 端組成 Tampermonkey 形狀的 response 物件並呼叫 `onload`/`onerror`。

### 4.3 `@require` / `@resource`

儲存腳本時在**伺服器端**抓下來（走 SSRF 防護、5MB 上限、逾時），用 sha256 內容定址存進 `assets`，投遞路徑 `/__lm/asset/<sha256>.js`。

理由：離線可用、不會把使用者的瀏覽行為洩漏給 CDN、內容定址天然有完整性保證。

`@require` 的 asset 以 `<script src>` 排在使用者腳本**之前**，順序照宣告順序。抓失敗 → 儲存腳本本身要成功，但在 UI 標示該 require 失效（不要讓一個掛掉的 CDN 擋住你存腳本）。

---

## 5. 後台 UI

```
┌─ LocalMonkey ─────────────── [腳本] [網站] ───────── + 丟腳本 ─┐
│ ┌────────────────┬──────────────────────────────────────────┐ │
│ │ ● abc      1.2 │ abc.user.js                  [儲存] ●啟用 │ │
│ │ ○ 蝦皮去廣告 2.1│ ───────────────────────────────────────── │ │
│ │ ● xyz      0.3 │ 配對  www.example.com · seller.shopee.tw  │ │
│ │                │ 權限  GM_setValue ✓   GM_xmlhttpRequest ✓ │ │
│ │                │ 時機  document-start                      │ │
│ │                │ ───────────────────────────────────────── │ │
│ │                │  1 // ==UserScript==                      │ │
│ │                │  2 // @name  abc                          │ │
│ │                │    ⋯ CodeMirror                           │ │
│ └────────────────┴──────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- **版面吃滿寬度**，不要固定寬度置中卡片。深色、密、接近編輯器的質感
- **左欄**：腳本清單（啟用圓點、名稱、版本）。點選切換
- **資訊列（配對／權限／時機）一律唯讀**，從編輯器內容即時解析（打字時 debounce 重新解析）。要改配對就改 header —— **單一真相來源**
- 未支援的 GM API 在權限列標紅
- `儲存` 時：重新解析 → 重算 `script_sites` → 新網域自動建站 → 抓 `@require`
- **`+ 丟腳本`**：貼上區（也接受拖放 `.user.js`）→ 解析 → 顯示偵測到的網域表（每列標 `ready` / `needs-host` / `rejected` 與原因）→ 按「部署」才真的寫入。這就是使用者描述的流程
- **網站分頁**：唯讀表格 —— 名稱、target_origin、代理網址（複製／開啟）、掛了哪些腳本、啟用開關。萬用子網域來的站可以在這裡加具體主機
- 鍵盤：`Ctrl+S` 儲存

### API

```
GET    /admin/api/scripts                 列表（不含 source，列表要輕）
GET    /admin/api/scripts/:id             單支（含 source + metadata）
POST   /admin/api/scripts                 { source } → 解析 + 建站 + 綁定
PUT    /admin/api/scripts/:id             { source?, enabled?, order_index? } → 重新解析 + 重算綁定
DELETE /admin/api/scripts/:id
POST   /admin/api/userscript/parse        { source } → 只解析不寫入（給「丟腳本」預覽用）
GET    /admin/api/sites                   唯讀清單（含掛了哪些腳本）
PATCH  /admin/api/sites/:id               只准改 enabled / name / target_origin（萬用子網域指定主機）
POST   /admin/api/sites                   手動建站（保留）
DELETE /admin/api/sites/:id
```

認證、CORS、跨站寫入檢查：**完全沿用 v1 SPEC §6.1**，不要改，不要加 CORS header，不要做「localhost 免驗證」。

---

## 6. 測試（≥80%，TDD）

解析器是純函式，應該測得又快又密。必測：

- **解析器**：多個 `@match`、locale 變體的 `@name`、缺 metadata block、`@grant none`、重複 key、CRLF 換行、BOM、header 裡有奇怪空白、`// @match` 前有空格
- **match 轉換**（最容易無聲出錯，要測厚）：`/*`→`*`、`/items/*`→`/items/**`、`/a/*/b`→`/a/**/b`、`*.example.com`→`needs-host`、`<all_urls>`→`rejected`、`*://*/*`→`rejected`、正則 `@include` 抽不出主機→`rejected`
- **migration**：v1 的 DB（有 `site_id`/`match_glob`/`code` 的 scripts）升級後資料完整、`head-end`→`document-start` 對應正確
- **多對多**：一支腳本兩個網域 → 改一次 source → 兩個站拿到的都是新版（這是核心賣點，一定要有測試釘住）
- **`document-start` 注入點**：真的插在 `<head>` 第一個子元素、在頁面自己的 script 之前；沒有 `<head>` 的 fallback
- **`@exclude`**：命中就不注入
- **GM shim 投遞**：`@grant none` 不投遞 shim；只暴露 `@grant` 列出的 API；未支援的 API 是會 `console.error` 的 stub
- **`/__lm/gm/xhr` 安全（每一條都要有測試）**：陌生 Origin → 403；目標不在 `@connect` → 403；`@connect *` → 拒絕；私網位址 → 擋；method 不在白名單 → 擋；超過大小上限 → 截斷或拒絕；不會轉發 admin token
- **`@require`**：抓下來內容定址、重複 URL 只抓一次、抓失敗不擋住儲存
- **既有的 241 條測試全部要繼續綠**（代理核心沒被改壞）

---

## 7. 完成的定義

1. `npm test` 全綠、覆蓋率 ≥80%，**貼實際輸出**
2. 端到端：真的起 server → 在「丟腳本」貼一支**帶 header、兩個 `@match`、用到 `GM_addStyle` 與 `GM_setValue`** 的腳本 → 看到兩個網域被列出 → 部署 → 兩個站都建好 → 打代理網址確認 shim 與腳本都注入、功能真的生效
3. 舊 DB 升級測試過（v1 資料不會掉）
4. commit + push

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，不准任何 Claude / Co-Authored-By 署名。

---

## §8 `.user.js` 投遞端點（讓 Tampermonkey 直接裝 + 自動更新）

### 動機

使用者實際的 7 支腳本有 6 支打 IG / Threads / X —— 要登入的 SPA、多主機、有風控，走反向代理做出來不會想用。而他**已經在做**正確的事：`ig-helper` 與 `xpost-card` 的 header 有 `@updateURL http://localhost:8001/scripts/...`，AutoReel 的 `backend/main.py` 手刻了 5 條路由在餵 `.user.js` 給 Tampermonkey。

LocalMonkey 直接取代那個角色：**在控制台用 CodeMirror 編輯 → 存檔 → 所有裝置的 Tampermonkey 自動更新**。腳本跑在 Tampermonkey 裡，所以 `GM_*` 全部原生可用、不碰 IG 風控、`*://*/*` 也能用。

**於是 LocalMonkey 有兩種投遞模式，每支腳本可以各自選：**

| | 代理模式（v1/v2 既有） | 投遞模式（本節新增） |
|---|---|---|
| 怎麼跑 | 經過代理網址，由伺服器注入 | Tampermonkey 從端點裝，跑在原站 |
| GM API | 靠我們的 shim | 原生，全支援 |
| 需要擴充功能 | 不用 | 要裝 Tampermonkey |
| 登入站/SPA | 多半會壞 | 正常 |
| `*://*/*` | 做不到 | 可以 |

### ⛔ 連帶的規格修正（§3.2）

原本 `*://*/*`、`<all_urls>` 判為 `rejected`。**那個判斷只對代理模式成立。**

改成兩個獨立欄位：
- `proxyable`：能不能建站代理（`ready` / `needs-host` / `rejected` + 原因）
- `deliverable`：**永遠為 true**，任何腳本都能投遞

UI 不要再說「這支不支援」，要說「這支不能用代理模式（原因…），但可以用投遞模式」。revid-subs 那支使用者一定會拿來試。

### 端點

```
GET /s/<token>/<slug>.user.js
```

- `<token>`：每支腳本一組 32 bytes 隨機 hex，存在 `scripts.delivery_token`（建立時產生，可在 UI 重新產生＝撤銷舊網址）
- **為什麼用路徑 token**：Tampermonkey 抓腳本時帶不了 admin bearer token，所以這個端點必須免認證。但腳本內容可能含金鑰（他的腳本就在打自己的後端），裸奔不行。不可猜的路徑 token 是這類問題的標準解。
- `<slug>`：人類可讀（從 `@name` 正規化），只為了讓 Tampermonkey 顯示好看的檔名，**不參與驗證**
- Token 查無 → **404**（不要 403，不要確認腳本是否存在）
- 停用的腳本 → 404
- `Content-Type: text/javascript; charset=utf-8` ← **一定要這個**。`text/plain` 會讓 Tampermonkey 不觸發安裝
- `Cache-Control: no-cache`，但要給 `ETag`（source 的 sha256）與 `Last-Modified`（`updated_at`），並正確處理 `If-None-Match` 回 304 —— 更新檢查很頻繁，別每次都傳整份
- 回傳 `source` **原文含 metadata header**（那就是安裝清單），但要先做下面的改寫
- 簡單速率限制

### 投遞時改寫 header（關鍵，少了這段整個功能沒意義）

回傳前把 header 裡的 `@updateURL` / `@downloadURL` 換成**本端點的絕對網址**，沒有就補上。否則 Tampermonkey 會繼續去 `localhost:8001` 更新，等於白做。

絕對網址的 host **從請求的 `Host` header 取**，不要從設定檔讀 —— 使用者會從 `127.0.0.1`、區網 IP、或 tunnel 網域來裝，每種都要給對應的網址。（這條是踩過的坑：後端自己組對外網址，在代理後面會組出內部位址。）

改寫只動投遞出去的那份，**不要改資料庫裡的 `source`**。

### ⛔ 版本號：最容易做出「看起來好了其實沒更新」的地方

**Tampermonkey 只有在遠端 `@version` 比本地高時才更新。** 使用者在控制台改完存檔、版本號沒動 → 所有裝置原地不動 → 他會以為功能壞了。

不要偷偷幫他改版本號（那會讓畫面上的 source 跟實際投遞的不一致）。做成明確的：

- 儲存時比對新舊 `@version`。沒變或變小 → 回應帶 `versionBumped: false`
- UI 顯示明顯的提示：**「版本號沒變，Tampermonkey 不會更新到這一版」**，旁邊一顆「版本 +1 並儲存」按鈕（自動把最後一段數字加一，沒有 `@version` 就補 `1.0.0`）
- 沒有 `@version` 的腳本也要提示：沒有版本號 = 永遠不會自動更新

### UI（腳本分頁的資訊列下方）

- **安裝網址**：可複製的完整 URL + 「開啟安裝」按鈕
- **重新產生網址**：撤銷舊的（警告：已安裝的裝置會更新失敗，要重裝）
- 顯示 `@updateURL` 會被改寫成什麼
- 版本提示（上面那條）

### API

```
POST /admin/api/scripts/:id/delivery-token/rotate   重新產生 token
```
`GET /admin/api/scripts/:id` 的回應要帶 `deliveryUrl`（用請求的 Host 組）。

### 測試

- `.user.js` 的 `Content-Type` 正確（**這條錯了整個功能靜默失效**）
- 錯 token / 不存在 token / 停用的腳本 → 全部 404，且回應內容不洩漏腳本是否存在
- `If-None-Match` 命中 → 304 且無 body
- 投遞出的內容裡 `@updateURL`/`@downloadURL` 已改寫成本端點；原本沒有這兩個 key 的也會被補上；DB 裡的 `source` 沒被改
- 改寫用的是請求的 `Host`（用不同 Host header 打同一支，拿到不同的絕對網址）
- 版本沒變 → `versionBumped: false`；「版本 +1」把 `1.2.3` 變 `1.2.4`、沒有 `@version` 的補上
- token rotate 後舊網址 404、新網址 200
- **用那 7 支真實腳本當 fixture 跑一遍投遞**，特別是 `revid-subs`（`*://*/*`，代理模式 rejected 但投遞模式必須正常）

### 不做

自動更新的伺服器推送、腳本市集、簽章。Tampermonkey 自己的週期性檢查就夠了。
