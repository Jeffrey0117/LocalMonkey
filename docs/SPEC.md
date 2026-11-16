# LocalMonkey — 規格書

> 自架油猴（Self-hosted Userscript Manager）
> 一句話：**讓網站變成我想要的樣子，而且任何裝置打開網址就有。**

來源：2026-11-16 與 ChatGPT 的設計討論（Project A）。本檔是實作契約，照這份做。

---

## 1. 產品定位

Reverse proxy 代理目標網站，在回應的 HTML 裡注入**我自己的 JS**。管理後台可以新增網站與腳本，**不需要重新部署**。

與瀏覽器油猴擴充功能的差別，也是整個專案存在的理由：

- 不用在每台裝置安裝擴充功能。手機、平板、別人的電腦，打開代理網址就有改造後的網站。
- 腳本集中管理、集中生效。改一次，所有裝置下次載入就是新版。

### 刻意不做的事（範圍防線）

這個專案的價值在於**簡單到不行卻很實用**。以下功能屬於姊妹專案 LocalDevTool，**不准**加進來：

- 流量記錄 / Network Inspector
- Playwright / CDP
- 右鍵挖掘、API 分析、影片來源追蹤

也不做：批量抓取、下載器、繞過付費牆。

---

## 2. 技術約束（硬性）

| 項目 | 規定 |
|---|---|
| Runtime | Node 24（本機實測 v24.16.0） |
| 框架 | Express 5。注意 Express 5 的 wildcard 語法是 `/{*splat}` 不是 `/*` |
| 模組 | CommonJS。`package.json` **必須**顯式寫 `"type": "commonjs"`（上層目錄可能有野生的 `"type":"module"` 害整個 app 崩潰） |
| DB | `better-sqlite3` 鎖 `^12`。**不准用 ^13**（13 起拿掉 prebuild，要 MSVC，這台沒有） |
| 依賴 | 零依賴優先。前端後台用原生 HTML/JS，**不准**有 build step（無 vite/webpack/tsc） |
| 測試 | 內建 `node:test` + `node --test --experimental-test-coverage`，不裝測試框架 |
| Port | 預設 `30600`（實測空的）。`PORT` env 可覆蓋 |
| 綁定 | 預設 `127.0.0.1`。`HOST` env 可改成 `0.0.0.0` 給同網段裝置用（README 要警告這等於把管理後台曝露到區網） |

檔案組織：多個小檔案 > 少數大檔案。單檔 200–400 行為常態，上限 800。函式 < 50 行。不可變寫法（展開新物件，不原地改）。

---

## 3. 資料模型（SQLite，`data/localmonkey.db`，gitignore）

```
sites
  id            TEXT PRIMARY KEY     -- slug，[a-z0-9-]{1,40}
  name          TEXT NOT NULL
  target_origin TEXT NOT NULL        -- 例 https://www.example.com（只存 origin，不含 path）
  enabled       INTEGER NOT NULL DEFAULT 1
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL

scripts
  id            TEXT PRIMARY KEY
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE
  name          TEXT NOT NULL
  code          TEXT NOT NULL
  enabled       INTEGER NOT NULL DEFAULT 1
  match_glob    TEXT NOT NULL DEFAULT '*'   -- 比對代理後的 path，glob：* 與 ** 與 ?
  run_at        TEXT NOT NULL DEFAULT 'body-end'  -- 'head-end' | 'body-end'
  order_index   INTEGER NOT NULL DEFAULT 0
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL
```

Migration 用「單向 schema 版本」簡單做法即可（`PRAGMA user_version`）。

---

## 4. 代理行為（這段是核心，寫錯整個產品不能用）

### 4.1 路由

1. 主路由：`ALL /p/:siteId/{*splat}` → 轉送到 `site.target_origin + /splat + ?query`
2. **根路徑 fallback**：`ALL /{*splat}`（放在最後）。用來接住頁面裡「根絕對路徑」的資源請求（`/assets/app.js`）。按順序解析 siteId：
   1. Cookie `lm_site`
   2. `Referer` header 裡的 `/p/<siteId>/`
   3. 都解析不到 → 404 加一行說明，不要 502（502 會讓人以為代理壞了）

   主路由回 HTML 時要 `Set-Cookie: lm_site=<siteId>; Path=/; SameSite=Lax`。
   **已知限制**：同一個瀏覽器同時開兩個不同代理網站會互搶 cookie。README 要寫明，不要假裝沒這回事。

3. 保留路徑（不進代理）：`/admin`、`/admin/api/*`、`/__lm/*`。Site slug 不准用 `admin`、`p`、`__lm`。

### 4.2 轉送請求

- 轉送 method 與 body（非 GET/HEAD 要帶 body；用 stream 或 buffer 都可，但 body 不能被吃掉）
- 移除 hop-by-hop 與會打壞上游的 header：`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-authorization`、`proxy-connection`、`te`、`trailer`、`host`、`content-length`
- `host` 設成上游 host。保留 `cookie`、`user-agent`、`accept*`、`content-type`
- 不要自己加 `accept-encoding`；Node fetch 會自動解壓，所以**回應**時必須丟掉 `content-encoding`

### 4.3 回應處理

丟掉這些回應 header（會擋掉注入或與解壓後的 body 不符）：
`content-security-policy`、`content-security-policy-report-only`、`x-frame-options`、`content-encoding`、`content-length`、`transfer-encoding`、`strict-transport-security`、`report-to`、`cross-origin-opener-policy`、`cross-origin-embedder-policy`

- **3xx**：`location` 指向 `target_origin` → 改寫成 `/p/<siteId>/...`；指向別的網域 → 原樣保留
- **set-cookie**：拿掉 `Domain=`、拿掉 `Secure`（本機是 http）、`SameSite` 改 `Lax`。多個 set-cookie 要用 `res.append` 逐條處理，不要合併成一條
- **HTML**（`content-type` 含 `text/html`）：
  1. 保守改寫根絕對路徑：`src="/x"`、`href="/x"`、`srcset`、`action="/x"`、`<link>` 的 href → `/p/<siteId>/x`。只改 `"` 或 `'` 開頭緊接單一 `/` 且**不是** `//`（protocol-relative）的情形。`//` 開頭的視為跨網域，不動
  2. 注入腳本：`run_at=head-end` 的插在 `</head>` 前，`body-end` 的插在 `</body>` 前，按 `order_index` 排序。找不到對應標籤就 append 到結尾
  3. 注入形式用 `<script src="/__lm/script/<scriptId>.js"></script>`（可被瀏覽器快取、錯誤行號正確、不會被 HTML 轉義搞爛）。**不准**把使用者的 JS 直接內嵌進 HTML 字串
- **非 HTML**：原樣回傳 buffer，設回原 `content-type`

### 4.4 錯誤處理

上游失敗 → 502 加一頁人看得懂的錯誤（目標、錯誤原因、常見原因），並 `console.error` 真實 cause。不要只回 `代理請求失敗`。

---

## 5. 腳本投遞

`GET /__lm/script/:scriptId.js`
- `Content-Type: application/javascript; charset=utf-8`
- `Cache-Control: no-cache`（改完要立刻生效）
- script 不存在或 disabled → 404
- 回傳的是 `code` 原文，外面包一層 `try/catch` 並在 catch 裡 `console.error('[LocalMonkey] <name> 執行失敗', e)`，避免一支壞腳本讓整頁掛掉

---

## 6. 管理後台

- `GET /admin` → 單頁 UI（原生 HTML + JS，無 build）。功能：網站列表 CRUD、每個網站的腳本 CRUD（含 code 編輯 textarea、啟用開關、拖拉或數字排序、match glob、run_at）、一鍵複製代理網址
- REST：
  - `GET/POST /admin/api/sites`、`GET/PUT/DELETE /admin/api/sites/:id`
  - `GET/POST /admin/api/sites/:id/scripts`、`GET/PUT/DELETE /admin/api/scripts/:scriptId`
- 輸入驗證：自己寫小 validator（零依賴），或用 zod（可接受的唯一例外）。slug 格式、`target_origin` 必須是合法 http(s) origin、`run_at` 只收兩個值、`code` 長度上限 1MB

### 6.1 認證（照這個做，不要自己發明）

- Token 來源：`LOCALMONKEY_ADMIN_TOKEN` env。沒設 → 首次啟動產生 32 bytes 隨機 hex，寫到 `data/admin-token.txt`（gitignore）並印在 log
- **絕對不准**有 hardcoded 預設 token，也不准「沒設就不驗證」
- 驗證接受：`Authorization: Bearer <token>` 或 cookie `lm_admin`。`GET /admin?token=<t>` 會設 cookie（`HttpOnly`、`SameSite=Strict`、`Path=/admin`）然後 302 到乾淨的 `/admin`，讓網址列不留 token
- **不准**「localhost 免驗證」。理由（真實事故）：本機免驗證 + CORS 寬鬆 = 使用者瀏覽器裡**任何**網頁都能 `fetch('http://127.0.0.1:30600/admin/api/sites')` 當管理員。所以：
  - 一律要 token
  - **不設**任何 CORS header（不要 `Access-Control-Allow-Origin`）
  - `/admin/api/*` 的寫入（POST/PUT/DELETE）要檢查 `Origin`/`Sec-Fetch-Site`：跨站一律 403
- 比對 token 用 `crypto.timingSafeEqual`（長度不同先擋）

### 6.2 SSRF 防護

代理任意網址是這個產品的本質，但要有底線：

- `target_origin` 只准 `http:` / `https:`
- 新增/更新網站時**和**每次代理請求時都解析 DNS，命中以下就拒絕：loopback（127/8、::1）、private（10/8、172.16/12、192.168/16、fc00::/7）、link-local（169.254/16、fe80::/10）、`0.0.0.0`、`metadata.google.internal`
- `LOCALMONKEY_ALLOW_PRIVATE=1` 可放行（給代理自己的 dev server 用），README 要說明風險
- 請求時也要檢查 → 擋 DNS rebinding

---

## 7. 測試（必做，覆蓋率 ≥ 80%）

TDD：先寫測試看它紅，再實作。測試用 `node:test`，server 綁 port 0 真的起起來打 fetch，上游用一個同樣跑在 port 0 的假 origin server（不要 mock fetch，測不到真東西）。

必測清單：
- URL 組裝（path、query、編碼過的字元、尾斜線）
- 請求 header 過濾（hop-by-hop 被移除、host 被改對）
- 回應 header 過濾（CSP / X-Frame-Options / content-encoding 被拿掉）
- HTML 注入：head-end / body-end 位置、order_index 順序、沒有 `</body>` 的 HTML、disabled 的腳本不注入、match_glob 不符不注入
- 根絕對路徑改寫：`"/a.js"` 改、`"//cdn/x.js"` 不動、`"https://x/y"` 不動
- siteId 解析優先序：cookie > referer > 404
- 3xx location 改寫（同源改、跨域不改）
- set-cookie 改寫（Domain 被拿掉、多條各自處理）
- 非 HTML 原樣回傳（binary 不被破壞 — 用一張小 PNG 做 byte-for-byte 比對）
- 上游掛掉 → 502 且不洩漏堆疊
- admin 認證：無 token 401、錯 token 401、對的 token 200、跨站 POST 403、timing-safe 比對有被呼叫
- SSRF：各種私網位址被拒；`ALLOW_PRIVATE=1` 時放行
- scripts/sites CRUD 與驗證錯誤

---

## 8. 交付物

- `README.md`：專業水準。一段 hook（為什麼不用瀏覽器擴充功能）、安裝、`npm start`、第一個腳本的 60 秒教學、架構圖、已知限制（cookie 單站、JS 動態組的跨域請求不經代理、不是繞付費牆工具）、安全注意事項
- `CLAUDE.md`：給未來接手的 agent 看。架構、各檔責任、怎麼跑、踩過的坑
- `.env.example`、`.gitignore`（`node_modules`、`data/`、`*.db`、`.env`）
- `npm start`、`npm test`、`npm run test:coverage`

## 9. 完成的定義

1. `npm test` 全綠，覆蓋率 ≥ 80%，**把實際輸出貼出來**
2. 真的起 server，用一個真實公開網站（例如 `https://example.com`）走完一次：建站 → 加一支把 `<h1>` 文字換掉的腳本 → 打代理網址 → 證明注入生效（curl 看到注入的 script tag 與改寫後的 HTML）
3. commit + push 到 GitHub
4. 回報時說明：哪些做了、哪些沒做、限制是什麼

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，**不准**加任何 Claude / Co-Authored-By 署名。
