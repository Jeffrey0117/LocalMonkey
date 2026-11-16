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
