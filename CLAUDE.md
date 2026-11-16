# CLAUDE.md — 給接手的 agent

LocalMonkey = reverse proxy + 在回應的 HTML 裡注入使用者自己的 JS。
產品面的說明看 [`README.md`](README.md)，實作契約看 [`docs/SPEC.md`](docs/SPEC.md)（那份是規格，不要偏離它）。

這份檔案記的是「**動手改之前你會想知道的事**」。

---

## 怎麼跑

```bash
npm install          # postinstall 會自動補 better-sqlite3 的 binding（見下面地雷 1）
npm start            # 預設 127.0.0.1:30600
npm test             # node:test，241 個測試
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
/__lm/*          → routes/internal.js     腳本投遞（不需要 token）
/admin, /admin/* → routes/admin-page.js   UI + API（都要 token）
/p/:siteId(/*)   → proxy/handler.js       主代理
/{*splat}        → proxy/handler.js       根路徑 fallback（cookie → Referer → 404）
```

代理管線（`proxy/handler.js` 的 `proxy()`）：

1. `lib/ssrf.js` → 解析 DNS、確認不是內網（**每個請求都做**，這是擋 DNS rebinding 的防線）
2. `proxy/body.js` → 讀請求 body（有大小上限）
3. `proxy/forward.js` → 組上游 URL + `fetch(…, { redirect: 'manual' })`
4. `proxy/respond.js` → 過濾回應 header、改 `Location`、改 `Set-Cookie`、
   HTML 的話再做路徑改寫與腳本注入

每一層都是獨立的純函式模組（`src/lib/*`），單元測試打的是它們；
整合測試打的是整條管線（真 server + 真假上游）。

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

---

## 改動時的注意事項

- **規格優先。** `docs/SPEC.md` 寫了「只改被引號包起來的屬性值」就不要擴大到無引號的，
  即使你在真實網站上看到 `<script src=/s.js>`（今天的 example.com 就是）。
  那種情形由根路徑 fallback 接住，README 的已知限制第 3 點有寫。
- **新增欄位要同時改四個地方**：`db/migrations.js`（加新版本，不要改舊的）、
  `db/scripts.js`（或 `sites.js`）的 `UPDATABLE_COLUMNS`、`lib/validate.js`、後台 UI。
- **測試是 TDD 寫出來的，先紅再綠。** 修 bug 時：先寫一個會紅的測試，
  確認它真的紅（把修改 revert 掉跑一次），再修。
- **覆蓋率門檻 80%，目前 97%。** 新程式碼請一起把測試補上。
- **不要留 `console.log`。** 要 log 就用 `src/logger.js`（`logger.info/warn/error`）。
  `src/public/*.js` 是瀏覽器端的後台 UI，那裡也不要留 debug log。
