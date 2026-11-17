# CLAUDE.md — 給接手的 agent

LocalMonkey = reverse proxy + 在回應的 HTML 裡注入使用者自己的 JS。
產品面的說明看 [`README.md`](README.md)。實作契約有兩份，都還有效：

- [`docs/SPEC.md`](docs/SPEC.md) —— **v1：代理核心**（路由、SSRF、認證、HTML 改寫）
- [`docs/SPEC-console.md`](docs/SPEC-console.md) —— **v2：油猴腳本控制台**（解析、多對多、GM API）
- [`docs/SPEC-dashboard.md`](docs/SPEC-dashboard.md) —— **v3：`<base>` 修正 + 儀表板**

這份檔案記的是「**動手改之前你會想知道的事**」。

---

## v2 的一句話

**使用者只丟一份 `.user.js`，其他全部從 userscript header 推出來。**

名稱、要代理哪些網域、執行時機、需要哪些 GM API、要載哪些 `@require` ——
header 裡全都有，所以後台**不提供第二個輸入口**。資訊列唯讀、跟著打字即時重新解析。
任何想「讓使用者再手填一次」的改動都是在製造第二個真相來源，先回去讀 SPEC-console §0。

### 兩種模式，同一份 source

| | 代理模式 | 投遞模式（SPEC-console §8） |
|---|---|---|
| 路徑 | `/p/<site>/…` + 注入 HTML | `GET /s/<token>/<slug>.user.js` |
| 跑在哪 | 我們改寫過的 HTML 裡 | 使用者的 Tampermonkey 裡 |
| GM API | 我們的 shim | 原生，全支援 |
| 要登入的站 / 配全世界的 pattern | 做不到 | 可以 |

所以每個 target 有**兩個獨立的軸**：`proxyable`（ready / needs-host / rejected）與
`deliverable`（永遠 true）。**不要再用「不支援」描述 rejected** —— 那只代表
「代理模式配不起來」，同一支腳本投遞出去完全正常（revid-subs 就是這種）。

---

## 怎麼跑

```bash
npm install          # postinstall 會自動補 better-sqlite3 的 binding（見下面地雷 1）
npm start            # 預設 127.0.0.1:30600
npm test             # node:test，772 個測試
npm run test:coverage
```

手動驗證（不要用 `run_in_background` 開長駐 server）：

```powershell
# 起
$env:PORT = "30610"
Start-Process -WindowStyle Hidden node "src/index.js" -WorkingDirectory "C:\Users\AUSER\code\LocalMonkey" `
  -RedirectStandardOutput "$env:TEMP\lm-out.log" -RedirectStandardError "$env:TEMP\lm-err.log"

# 收（用確切 PID，絕對不要 taskkill /IM node.exe）
Get-NetTCPConnection -LocalPort 30610 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

token 在 `data/admin-token.txt`（gitignore）。測 JSON API 用 **bash 的 curl 或 node fetch**，
不要用 PowerShell 的 `curl -d`（它會吃掉內嵌的雙引號）。

---

## 架構：一個請求怎麼走

路由順序在 `src/app.js`，**順序本身就是規格**：

```
/__lm/gm/xhr     → routes/gm-xhr.js       GM_xmlhttpRequest 轉發（不需要 token）
/__lm/*          → routes/internal.js     腳本 / shim / 資產投遞（不需要 token）
/admin, /admin/* → routes/admin-page.js   控制台 + API（都要 token）
/p/:siteId(/*)   → proxy/handler.js       主代理
/{*splat}        → proxy/handler.js       根路徑 fallback（cookie → Referer → 404）
```

⚠️ `gm/xhr` 一定要掛在 `internal` **之前** —— internal router 的尾巴是 catch-all 404。

代理管線（`proxy/handler.js` 的 `proxy()`）：

1. `lib/ssrf.js` → 解析 DNS、確認不是內網（**每個請求都做**，這是擋 DNS rebinding 的防線）
2. `proxy/body.js` → 讀請求 body（有大小上限）
3. `proxy/forward.js` → 組上游 URL + `fetch(…, { redirect: 'manual' })`
4. `proxy/respond.js` → 過濾回應 header、改 `Location`、改 `Set-Cookie`、
   HTML 的話再做路徑改寫與腳本注入

HTML 的網址改寫走 `lib/html.js` 的 `rewriteDocumentUrls()`，**順序是規格的一部分**：

```
<base href>      lib/base-tag.js      指向本站 → /p/<siteId>/；別的網域原樣保留
<meta refresh>   lib/meta-refresh.js  同上（不改的話幾秒後使用者就離開代理了）
根絕對路徑        rewriteRootPaths     src/href/action/poster/formaction + srcset
```

前兩步要在根絕對路徑**之前**做。它們共用 `lib/proxy-path.js` 的
「這個網址指向被代理的站嗎」判斷（絕對網址 / protocol-relative / 根相對路徑都吃）。

每一層都是獨立的純函式模組（`src/lib/*`），單元測試打的是它們；
整合測試打的是整條管線（真 server + 真假上游）。

### 存一支腳本怎麼走

```
POST /admin/api/scripts { source }
  → userscript/parse.js      解析 header（純函式，不碰 DB/網路）
  → services/deploy.js
      ├─ resolveTargets      每個 @match → ready / needs-host / rejected
      │                      ready 的就 ensureSite（已有同 target_origin 的站就重用）
      ├─ collectAssets       抓 @require / @resource（SSRF + 上限，失敗不擋存檔）
      ├─ writeScript         寫 scripts（source + metadata JSON）
      └─ setBindings         整批換掉 script_sites
  → 回 { script, targets, warnings }   targets 就是 UI 的「偵測到的網域」表
```

### 注入一頁怎麼走

```
proxy/respond.js
  → userscripts.listForInjection(siteId)   一個綁定一列（JOIN script_sites）
  → lib/injection.js planInjection()       比對 path_glob、套用 exclude、去重、分三個桶
  → lib/html.js injectScripts()             headStart / head / body
```

每支腳本的投遞順序固定是 **GM shim → `@require` 資產 → 腳本本身**。

### 投遞一份 .user.js 怎麼走

```
GET /s/<token>/<slug>.user.js      ← Tampermonkey（匿名，它帶不了 admin token）
  → userscripts.getByDeliveryToken  token 不是 64 hex 就不查 DB
  → services/delivery.js
      ├─ buildDeliveryUrl          用「這個請求的 Host」組絕對網址
      └─ rewriteHeaderUrls         換掉 @updateURL / @downloadURL（只動送出去的那份）
  → ETag（投遞內容的 sha256）+ Last-Modified；If-None-Match 命中就回 304
```

---

### 後台前端（v3 之後是兩層）

```
index.html          三個分頁：已安裝的腳本 / 網站 / 設定
  ui.js             escapeHtml / byId / debounce / banner / delegate
  format.js         大小、相對時間、排序（純函式，vm 裡測得到）
  api.js            /admin/api/* 的呼叫層
  scripts-table.js  第一層：表格 + 排序 + 開關 + favicon + 功能圖示
  scripts-tab.js    第一層 ↔ 第二層的協調者
  info-bar.js       編輯器上方那排唯讀資訊（跟著打字即時重新解析）
  editor.js         CodeMirror 的薄包裝
  sites-tab.js / settings-tab.js / drop-script.js / app.js
```

`.console` 是一個**單欄單列**的 grid，`#list-view` 與 `#editor-pane` 疊在
同一個格子裡靠 `hidden` 切換。兩個都要明確寫 `grid-column: 1; grid-row: 1`
（理由見地雷 26 —— 沒寫的話第二個會掉到隱含的第二列）。

## 資料模型（v2）

```
sites          id(slug) / name / target_origin / enabled / auto_created / from_pattern
scripts        id / name / version / description / source / metadata(JSON) / run_at
               enabled / order_index / delivery_token
script_sites   (script_id, site_id, path_glob) PK / exclude_glob(JSON 陣列)
assets         sha256 PK / url / content(BLOB) / content_type / bytes / fetched_at
```

- **`source` 是唯一真相來源**，`metadata` 只是解析結果的快取（存檔時重算）。
- **`exclude_glob` 存的是 JSON 陣列**（一個站可能有多條排除規則）。欄位名是單數，
  因為 SPEC 這樣寫；讀寫一律走 `db/userscripts.js` 的 `decodeExcludes` / `encodeExcludes`。
- **`store.scripts` 是 v1 的相容投影**（`code` ← `source`、`site_id` / `match_glob` ← 第一個綁定），
  `store.userscripts` 才是 v2 的 API。兩者背後同一組表。新功能一律用後者。
- `assets` 是純內容儲存；「哪支腳本要載哪些資產」記在該腳本的 `metadata.requireAssets`
  / `resourceAssets`（含 `sha256`，抓失敗時是 `null` + `error`）。
- **`delivery_token`（v3）是投遞端點的憑證**，UNIQUE，建立時產生、可以輪替（＝撤銷舊網址）。
  migration 會幫既有資料回填，而且**重複跑 migrate 不會換掉既有的 token** ——
  已經安裝好的裝置還要靠它更新。

---

## 設計決策（以及為什麼）

- **上游 path 用 `req.originalUrl` 切，不用 express 的 params。**
  Express 5 會把 params 解碼，解碼再編碼會改掉 `%2F`、`+` 這些字元。
  `proxy/handler.js` 的 `upstreamPathFromOriginalUrl()` 直接切原始字串。
- **HTML 改寫走 latin1。** `buffer.toString('latin1')` → 改 → `Buffer.from(…, 'latin1')`
  是 byte-lossless 的，所以不用猜頁面的 charset（UTF-8、Big5 都不會被改壞）。
  前提是我們插入的東西全是 ASCII（script tag 與 `/p/<slug>/`，slug 限定 `[a-z0-9-]`）。
- **注入用外部 `<script src>`，不內嵌。** 可被瀏覽器快取、錯誤行號正確、
  不會被 HTML 轉義搞爛。`lib/user-script.js` 會包一層 try/catch，
  一支壞腳本不會讓同頁其他腳本跟著死。
- **`match_glob` 單獨一個 `*` 是 match-all 的特例。** 一般語意裡 `*` 不跨 `/`，
  但 DB 預設值就是 `*`，它的意思必須是「所有頁面」。`lib/glob.js` 有註解說明。
- **SSRF 認不出來的 IP 一律當封鎖**（fail closed，`lib/ip.js`）。
- **`admin/compare.js` 刻意寫成 `crypto.timingSafeEqual(…)` 而不是先 destructure**，
  測試才 spy 得到它真的被呼叫。改這個檔案時別「順手整理」成 destructure。
- **後台 cookie 的 `Path=/admin`**，所以同一個 cookie 也涵蓋 `/admin/api/*`。
- **沒有任何 CORS header，而且跨站寫入直接 403。** 理由寫在 README 的安全段，
  不要為了「方便前端」加 `Access-Control-Allow-Origin`。
- **`app.disable('etag')`**：回應是我們改寫過的，不要讓 express 算 etag。
- **`@match` 的路徑一定要做語意轉換。** Chrome match pattern 的 `*` 跨 `/`，
  我們的 glob 單星號不跨。`userscript/match.js` 的 `matchPathToGlob` 負責這件事，
  而且有一條「照抄會壞掉」的回歸測試釘著。
- **GM_* 不掛到 `window`，而是宣告成該腳本的區域變數**（`lib/user-script.js` 產生
  `var GM_setValue = __lmApi["GM_setValue"];`）。掛 window 的話同一頁多支腳本會互相蓋掉，
  `document-idle` 的腳本執行時所有 shim 都裝完了，百分之百拿到別人的 API。
- **`@grant` 的值會變成變數名稱**，所以一律過 `isValidGrantName()` 的識別字濾網。
  那是使用者可以隨便打的字串，不濾就是程式碼注入。
- **`document-idle` 的包裝不用任何全域名字**（IIFE + 區域 `var`）。用 `function run()`
  的話第二支 idle 腳本會覆蓋第一支，結果只有一支執行而且完全不報錯。
- **`/__lm/gm/xhr` 的 header 是白名單組出來的**，不是把進來的請求複製一份。
  這是「後台 token 不可能外流」的結構性保證，不要為了方便改成複製再刪。
- **`gm/xhr` 的轉址自己跟**（`redirect: 'manual'` + 每跳重驗）。用 fetch 預設的
  自動跟隨，等於讓目標網站用一個 302 把我們導去 evil.test 或 127.0.0.1。
- **gm/xhr 的 siteId 解析是 Referer 優先**（跟代理的 fallback 相反）。cookie 只有一份，
  使用者同開兩個代理網站會互搶，而這裡是安全判斷，要用「這一頁」的證據。
- **`/__lm/asset/*` 的 content-type 只放行 js / css / image / json**，其餘降級成 text/plain。
  資產是從我們自己的 origin 送出去的，照抄上游的 `text/html` 等於給它一個同源頁面
  去打 `/admin/api/*`（後台 cookie 的 `Path=/admin` 會被瀏覽器帶上）。
- **CodeMirror 是 vendor 進 repo 的單一檔案**（`src/public/vendor/codemirror.js`，
  核心 + JS mode + 三個 addon 串接，原樣沒改）。不准加 build step、不准從 CDN 載。
  要升級就照檔頭註解的順序重新串一次。
- **刪站只刪「因此變成沒有任何綁定」的腳本。** v1 的語意是「刪站連帶刪腳本」，
  但 v2 的腳本可以暫時誰都不掛（`@match` 還沒寫好），那種不該被無關的刪站牽連。
- **`GM_download` 的 `<a download>` 只准配 blob: / data: 的 href。** 遠端網址要先
  fetch 成 blob —— 跨來源時瀏覽器會忽略 download 屬性改成「導航」，等於把使用者
  正在看的頁面弄掉。抓不到就 onerror + warn，**絕不點那個連結**。
- **`LOCALMONKEY_GM_ALLOW_HOSTS` 不是 `LOCALMONKEY_ALLOW_PRIVATE` 的替代品。**
  前者只影響 `/__lm/gm/xhr`、精確比對 `host:port`、預設空的；後者是代理目標的全域開關。
  命中白名單只豁免「私網位址」那條，`@connect` 還是要過（兩道都要過）。
- **投遞的絕對網址用請求的 `Host` 組，不從設定讀。** 使用者會從 `127.0.0.1`、區網 IP、
  tunnel 網域來裝，每種都要給對應的網址。（踩過的坑：後端自己組對外網址，在代理後面
  會組出內部位址。）`Host` 是請求端可控的，所以有限字集。
- **版本號不要幫使用者偷偷改。** 存檔只回報 `versionBumped`，由 UI 問他要不要「版本 +1」；
  真的要改的時候是**伺服器端**改 source 再存（這樣畫面上的 source 跟實際投遞的永遠同一份）。
- **`<base>` 的比對用 `host` 而不是整個 origin。** 同主機但 scheme 不同（舊站留著
  `http://`）照樣會把瀏覽器帶離代理，那不是「跨網域意圖」。`lib/proxy-path.js` 有註解。
- **favicon 是伺服器端自己抓的，不准用 `google.com/s2/favicons`。** 第三方 favicon 服務
  等於把「使用者代理了哪些網站」整份洩漏出去。而且**上游的 `image/svg+xml` 一律拒收** ——
  SVG 可以內含 `<script>`，而那張圖是從我們自己的 origin 送出去的（同 `safeAssetContentType`）。
- **`/__lm/favicon/<siteId>` 永遠回 200 的一張圖。** 抓不到、站不存在、被 SSRF 擋下來
  都回內建佔位 SVG。回 404 的話列表會有一排破圖加一排 console 錯誤；而且「站不存在」
  與「抓不到」回一樣的東西，這個匿名端點就不會洩漏哪些站存在。
- **後台列表的欄位從 `metadata` 算，不從 `source` 算**（`lib/script-features.js`）。
  列表一次畫十幾支，不能為了一排小圖示把每支 source 讀出來重新解析。
- **「設定」分頁是唯讀的，而且只回路徑不回 token。** 那些值是 env，改了要重啟才生效，
  做成輸入框等於騙人。token 的值沒有理由進 JSON 回應（會留在網路紀錄、擴充套件、截圖）。
  兩件事都有測試釘著。

---

## 踩過的地雷（照時間順序，別重踩）

1. **npm 12 預設擋掉依賴的 install script** → `better-sqlite3` 不會下載 prebuilt binary，
   `require` 的時候才爆 `Could not locate the bindings file`。
   `npm install-scripts approve better-sqlite3` 會把 `allowScripts` 寫進 `package.json`，
   **但（實測）它沒有真的去跑那支 script**。真正有效的是在套件目錄裡手跑：
   ```bash
   cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js
   ```
   已經包成 `scripts/ensure-sqlite-binding.js` 掛在 `postinstall`（實測會跑，且會自我修復）。
2. **`better-sqlite3` 鎖 `^12`。** 13 起拿掉 prebuild，只剩 `node-gyp`，而這台機器沒有 MSVC。
3. **Express 5 的 wildcard 是 `/{*splat}`，不是 `/*`。** 寫成 `/*` 會直接丟 path-to-regexp 的錯。
4. **回 413 之前不要 `req.destroy()`。** 第一版在 body 超過上限時直接 destroy，
   結果 413 還沒送出 socket 就斷了 —— 客戶端只看到 `ECONNRESET`，什麼訊息都拿不到。
   正解是 `req.pause()` + 回應帶 `connection: close`（`proxy/body.js` 有註解）。
5. **Node 的 http client 不准在非 chunked 的請求上送 `trailer` header**
   （`ERR_HTTP_TRAILER_INVALID`）。所以「`trailer` 有沒有被過濾掉」這條只能在
   `tests/unit/headers.test.js` 驗，整合測試裡不要送它。
6. **透過 shell 傳非 ASCII 的 JSON 會被 Windows 的 codepage 吃掉。**
   實測：用 bash 的 curl `-d '{"name":"換標題"}'` 存進 DB 的是亂碼；
   用 node `fetch` + `JSON.stringify` 存進去的是乾淨 UTF-8（server 兩邊都沒問題，
   壞的是中間那層 shell）。要測中文就寫一支 `.js` 用 fetch。
7. **PowerShell 讀 UTF-8 log 檔會顯示亂碼**（主控台 codepage 是 Big5），檔案本身是好的。
   不要因此去「修」logger。
8. **這台機器的 port 30600 被另一個不相關的 `server2.js` 占著。**
   驗證時用 30610。不要去殺別人的 process（規則：`forbidden-commands.md`）。
9. **測試目錄叫 `tests/` 不是 `test/`。** `node --test` 的預設 discovery 會把
   「任何 `test/` 目錄底下的 `.js`」當成測試檔，那樣 `tests/support/*.js` 會被當測試跑。
   npm script 也明確寫了 glob：`node --test "tests/**/*.test.js"`。
10. **`express.json()` 的 parse error 要靠「註冊在路由後面」的 error handler 接。**
    `routes/admin-api.js` 的最後兩個 `router.use` 順序不能調（404 → error handler）。
11. **v2 的 migration 不能直接 `DROP TABLE scripts`。** 開著外鍵時 DROP 會先做一次
    隱含的 `DELETE FROM`，而 `script_sites` 的 `ON DELETE CASCADE` 會把剛剛搬好的綁定
    一起清掉。正解是「先把舊表 rename 成 `scripts_v1` → 建新表 → 複製 → 最後才 DROP 舊表」，
    而且 `script_sites` 要在複製完之後才建。
12. **`vm` context 回傳的陣列是另一個 realm 的 `Array`。** `assert.deepEqual` 會以
    「same structure but not reference-equal」失敗。測 GM shim 回傳的清單要先 `Array.from`。
13. **在原始碼裡寫 U+2028 / U+2029 的字面字元是看不見的坑。** `lib/gm-shim.js` 的
    `safeJson` 一開始被寫成 `.replace(/ /g, …)`（那其實是空白），等於把 JSON 裡所有空白
    換成 ` `。要用 `/ /g` 這種轉義寫法，而且加一條「空白沒被動到」的測試。
14. **判斷「PUT 要走 v2 還是 v1」不能用「v2 validator 過得了」。** v2 的 validator 只挑
    `source` / `enabled` / `order_index`，其他欄位（`code`、`match_glob`）會被當不認識的
    欄位忽略 —— 結果使用者改的東西被靜默丟棄。要用 `isV2OnlyBody()`（body 的 key 全部是
    v2 的 key 才算）。
15. **`INSERT OR IGNORE` 會把外鍵違規也一起吞掉。** `setBindings` 本來想用它去重，
    結果「指到不存在的 site」變成靜默跳過而不是丟錯。去重改在 JS 裡做，INSERT 保持會丟錯。
16. **測 `@require` 之類要發請求的流程，一定要注入 `fetchImpl` 與 `lookup`**
    （`services/deploy.js` 的 context 兩個都收）。不注入就會真的打外網，測試會變慢又會飄。
17. **`new Response('字串')` 不會帶 `content-length`。** 所以 `readCapped` 會走 stream 路徑，
    「宣告長度就超過上限」那條分支要用真的 http 上游（寫 `content-length`）才測得到。
18. **前端沒有瀏覽器可以跑，所以「語法錯誤」與「資源路徑打錯」會完全無聲。**
    `tests/integration/admin-console-page.test.js` 用 `vm.Script` 檢查每支前端 JS，
    並且逐一請求 `index.html` 引用的每個 `/admin/` 資源。加新的前端檔案時不用改測試
    （它掃目錄），但**新增 `<script src>` 一定要跑一次測試**。
25. **⛔ 用 `hidden` 屬性當顯示開關的元素，CSS 不能給它 `display`。**
    作者樣式贏過瀏覽器預設的 `[hidden] {display:none}`（跟選擇器權重無關），
    所以 JS 設了 `hidden` 卻完全藏不住，而且不報錯。這個專案中招過三個：
    `.editor-pane`、`#version-hint`、`.delivery-row`（都是 `display:flex`）。
    已經在 app.css 最前面放了 `[hidden] {display:none !important}` 一次擋掉整類。
26. **grid 的子元素比欄數多，又沒寫 `grid-template-rows` → 多出來的會掉到隱含的第二列。**
    控制台的 `.console` 是兩欄但有三個子元素（清單 + 編輯器 pane + 空狀態 pane），
    空狀態因此跑到視窗左下角、貼著左緣；而且列高由內容決定，編輯器在 744px 的視窗裡
    只到 y≈420。修法是把兩個 pane 都明確放在 `grid-column: 2; grid-row: 1`，
    並把列寫成 `minmax(0, 1fr)`（那個 0 等同 min-height:0，少了它內容會把列撐開）。
27. **CSS 版面的 bug，`vm.Script` 與資源路徑檢查完全抓不到**（地雷 18 只擋語法與 404）。
    `admin-console-page.test.js` 現在會斷言那幾條「撐滿高度 / hidden 蓋得過 display /
    pane 放在第二欄」的規則存在 —— 比沒有好，但真的要量 layout 還是得開瀏覽器
    （這次是用 claude-in-chrome 量 getBoundingClientRect 驗完的）。

19. **在區塊註解裡寫出「星號加斜線」的 pattern 字面值會把註解提前關掉。**
    `src/userscript/match.js` 的檔頭註解就這樣炸過一次（整個檔案語法錯誤，
    而且錯誤訊息只說 `Unexpected token '*'`）。要舉那個例子就用文字描述。
20. **`node -e "…"` 經 bash 傳的字串裡不要出現 `<token>` 這種角括號。**
    bash 會把它當成重導向（`token: No such file or directory`），整個腳本是壞的
    但表面上只會看到一行怪錯誤。要寫這種內容就寫成 `.js` 檔再跑。
21. **複製 SQLite 檔做升級驗證時，`-wal` 與 `-shm` 要一起複製。**
    WAL 模式下最近的 commit 還在 `-wal` 裡，只複製 `.db` 會得到一個
    `user_version = 0`、連表都沒有的檔案 —— 看起來像資料不見了，其實是沒複製完。
22. **`@connect` 不帶 port，而 GM 白名單一定帶 port。** 所以 UI 的「會不會被擋」
    只能比對 hostname（白名單裡有沒有哪一筆的 hostname 等於這個宣告）。
    那是**提示**，真正的授權判斷在伺服器端（`isAllowedHost` 精確比對 `url.host`）。
23. **改了「什麼算未支援的 GM API」就要改測試的樣本。** 實作 `GM_download` 之後，
    四條以它當「未支援」樣本的測試會紅。測試要挑真的沒實作的（`GM_cookie`）。
24. **用 `&&` 串 `npm test` 與 `git commit` 不會擋住失敗的 commit**，因為中間那段
    `grep` 有找到東西就回 0。我用這招推過一次紅的（`de64785`）。要擋就看 `npm test`
    自己的 exit code，別讓 grep 吃掉它。

28. **⛔ `curl` 驗不出 `<base href>` 造成的災難。** curl 不解析 `<base>`，所以
    `curl /p/<site>/x.css` 回 200 一切正常 —— 但真瀏覽器會拿原站的 base 去解析那個路徑，
    實際打的是 `https://原站/p/<site>/x.css` → 全部 404、整頁沒樣式。
    唯一驗得到的方式是**真的開瀏覽器**然後看
    `performance.getEntriesByType('resource')` 的 `transferSize`（壞掉時全是 0，
    而且 `name` 的前綴是原站不是代理）。注入的 `<script>` 也一樣
    —— **tag 在 DOM 裡不代表它載得到**，要看 `transferSize` 或腳本的副作用。
29. **`(["'])([^"']*)\1` 這種「引號 + back-reference」的屬性比對有盲點。**
    負向字元類裡不能放 back-reference，所以只能同時排除兩種引號 —— 於是
    `content="0; url='https://x/'"`（外層雙引號、內層單引號）**整個比對失敗**。
    要用 `"[^"]*"|'[^']*'` 的交替寫法（`lib/attribute.js` 包好了，新的屬性改寫直接用它）。
30. **SQLite 的 `LENGTH()` 對 TEXT 回的是字元數，不是 byte 數。**
    中文註解的腳本大小會被短報三倍。要 byte 就 `LENGTH(CAST(source AS BLOB))`。
31. **瀏覽器的 cookie 不分 port。** 同時在 `127.0.0.1` 上開兩個 LocalMonkey 實例驗證時，
    後登入的那個會把 `lm_admin` cookie 蓋掉，另一個就變 401 —— 看起來像「後台壞了」。
    每次換 port 都重新帶一次 `?token=`。（這跟 README 已知限制 1 的 `lm_site` 是同一個根因。）
32. **測 `src/public/*.js` 的純函式可以用 vm + 假 `window`**（`tests/unit/dashboard-format.test.js`），
    但回傳的陣列是**那個 realm 的 Array** → `deepEqual` 會失敗（同地雷 12）。先 `Array.from`。
33. **⛔ 代理回的 HTML 沿用上游的快取指示 → 改完的東西永遠到不了瀏覽器。**
    templatemo 回 `max-age=86400`，Chrome 就吃自己的快取一整天：`<base>` 的修正
    早就上線、`curl` 拿到的是新的，但瀏覽器裡的 `<base href>` 還是舊值。
    **伺服器端所有證據都說它是好的，而使用者看到的是壞的。**
    已修（`lib/cache-policy.js`：HTML 一律 `no-store`，非 HTML 不動）。
    留下兩個教訓：① `curl` 與瀏覽器看到的可以是不同的東西，驗 UI 一定要開瀏覽器
    ② 我們回的 HTML 是**改造過的**，任何「照抄上游 header」的直覺都要先問
    「這個 header 是在描述上游那份，還是我們這份？」
34. **驗證快取行為不要用 query string 繞。** `?nocache=1` 會被原站 301 正規化掉
    （我們的 Location 改寫是對的，所以你會被導回沒有 query 的網址 → 又中快取）。
    **換一個 port 最乾淨**：瀏覽器的快取 key 含 port，新 port ＝ 全新的快取。
    要確認某張頁面是不是從快取來的，看
    `performance.getEntriesByType('navigation')[0].transferSize`（0 ＝ 用快取）。

---

## 改動時的注意事項

- **規格優先。** `docs/SPEC.md` 寫了「只改被引號包起來的屬性值」就不要擴大到無引號的，
  即使你在真實網站上看到 `<script src=/s.js>`（今天的 example.com 就是）。
  那種情形由根路徑 fallback 接住，README 的已知限制第 3 點有寫。
- **新增欄位要同時改四個地方**：`db/migrations.js`（加新版本，不要改舊的）、
  `db/userscripts.js`（或 `sites.js`）的 `UPDATABLE_COLUMNS`、`lib/validate.js`、控制台 UI。
- **既有的 241 條 v1 測試一條都沒改**（除了一行：`edge-cases.test.js` 用 monkey-patch
  模擬「注入時 DB 炸掉」，而注入入口從 `scripts.listActiveForSite` 換成了
  `userscripts.listForInjection`。不改的話那條會對著不存在的接縫做斷言，變成永遠綠的假測試）。
  改 v1 的相容層時請維持這個紀律：**v1 的 API 形狀是契約，不是實作細節**。
- **真實腳本的 header 存在 `tests/fixtures/real-userscripts/`**（使用者實際要用的 7 支）。
  改解析器、改 GM 支援清單、改投遞邏輯之後都要跑 `tests/unit/real-userscripts.test.js`
  與 `tests/integration/delivery.test.js` —— 那些比自己編的測資有價值，而且已經抓到過
  「規格把 `GM_download` 列成不支援」這種錯。fixture 原樣保留 CRLF 與中文，不要「整理」它。
- **GM shim（`src/public/gm-shim.js`）是真的會跑在別人網站上的程式。**
  每個 API 都要「自己的錯誤吞掉 + `console.warn`」。測試請加進
  `tests/unit/gm-shim.test.js`，用 `tests/support/dom.js` 的假 DOM 真的執行它 ——
  比對字串測不到「localStorage 被停用時會怎樣」這種事。
- **測試是 TDD 寫出來的，先紅再綠。** 修 bug 時：先寫一個會紅的測試，
  確認它真的紅（把修改 revert 掉跑一次），再修。
- **覆蓋率門檻 80%，目前 97%。** 新程式碼請一起把測試補上。
- **不要留 `console.log`。** 要 log 就用 `src/logger.js`（`logger.info/warn/error`）。
  `src/public/*.js` 是瀏覽器端的後台 UI，那裡也不要留 debug log。
