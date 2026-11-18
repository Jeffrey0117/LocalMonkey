# CLAUDE.md — 給接手的 agent

LocalMonkey = reverse proxy + 在回應的 HTML 裡注入使用者自己的 JS。
產品面的說明看 [`README.md`](README.md)。實作契約有兩份，都還有效：

- [`docs/SPEC.md`](docs/SPEC.md) —— **v1：代理核心**（路由、SSRF、認證、HTML 改寫）
- [`docs/SPEC-console.md`](docs/SPEC-console.md) —— **v2：油猴腳本控制台**（解析、多對多、GM API）
- [`docs/SPEC-dashboard.md`](docs/SPEC-dashboard.md) —— **v3：`<base>` 修正 + 儀表板**
- [`docs/SPEC-translate.md`](docs/SPEC-translate.md) —— **v4：伺服器端翻譯層**（切段、ollama、快取、爬蟲）
- [`docs/SPEC-rules.md`](docs/SPEC-rules.md) —— **v5：站台改造規則**（隱藏、改寫文字、資源覆寫）
  ＋ **v6（同一份的 §8~§11）**：內容雜湊 cache busting、開發模式、`css` 規則型別

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
npm test             # node:test，1311 個測試
npm run test:coverage
```

v4 的翻譯層需要本機 **ollama**（`http://127.0.0.1:11434`，預設模型 `qwen2.5:latest`）。
**沒裝也不影響其他功能** —— 每個站的 `translate_enabled` 預設是 0，而且連不上時
代理照常回原文（有測試釘著）。

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

`proxy/respond.js` 的 `transformHtml()` 把三層改寫串起來，**順序同樣是規格**：

```
1. 網址改寫   rewriteDocumentUrls()
2. 翻譯回填   translate/service.js  ← 要在 1 之後：切段器算的是字元座標，
                                       之後的任何字串改動都會讓座標失效
3. 改造規則   rules/service.js      ← 文字規則套在**翻譯後**的文字上（v5），
                                       hide / css 的 CSS 插在 </head> 之前
4. cache bust lib/cache-bust.js     ← 要在 1~3 **之後**：它改的是屬性值，
                                       放前面會讓切段器的座標全部失效（v6）
5. 腳本注入   injectScripts()       ← 只在頭尾加 tag，不影響前四步
```

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

### 翻一頁怎麼走（v4）

```
proxy/respond.js → translate/service.js translateHtml()   ← 同步！
  → charset.js       只有明確宣告 UTF-8 的文件才翻（理由見下面的設計決策）
  → pipeline.js      collectSegments()：segment → splitEdges → decodeEntities
                     → normalizeSpace → isTranslatable（rules.js）
  → cache.js         批次查 translations（一次 SQL，manual 壓過 machine）
      命中 → 用
      沒命中 → **保留原文** + enqueue + queue.kick()（射後不理）
  → pipeline.js      renderTranslated()：前後空白原樣放回、重新編碼 entity
  → html-lang.js     真的翻了才把 <html lang> 改成目標語言
```

背景佇列（`translate/queue.js`）是**序列化**的，跟請求路徑完全脫鉤：

```
queue.drain() → claim(batchSize, exclude=這一輪試過的)
              → translateChunk()  ← 對不上就二分，見下
              → 成功：寫 translations（manual 不准被覆蓋）+ 清出佇列
                失敗：退回原文、記 last_error、**換下一批繼續**
```

**失敗就二分**（`translateChunk`）—— 這是整個佇列最重要的一段：

```
20 段 →(模型回 35 個 key) 10 + 10 →(還對不上) 5+5+5+5 → … → 單段
                                                            ↑
                              單段不可能數量對不上（送 1 回 1），所以一定收斂
```

`error.kind` 決定失敗之後怎麼辦（分類在 `ollama.js`）：

| kind | 二分？ | 燒 attempts？ | 這一輪繼續？ |
|---|---|---|---|
| `alignment`（模型回了但答案錯） | **是** | 只有單段也失敗才算 | 是 |
| `timeout` / `unreachable` / `http`（沒拿到答案） | 否 | **否** | 否（收手） |

`src/translate/` 的分工（每支都小，純函式的部分測得最密）：

```
segment.js      HTML → 文字段清單（狀態機，保證 html.slice(start,end) === raw）
rules.js        哪些段不翻（太短 / 純數字 / URL / 已含 CJK / 術語 / 太長）
entities.js     entity 還原與重新編碼
glossary.js     術語保護（詞邊界自己做）
charset.js      這份文件能不能安全地插入 UTF-8 中文
bytes.js        latin1 管線字串 ↔ 真文字
pipeline.js     collectSegments / uniqueTexts / renderTranslated
html-lang.js    翻完把 <html lang> 改掉
prompt.js       給模型的 prompt（索引當 key）
ollama.js       批次呼叫 + **對齊防呆**（整個功能最危險的地方）
cache.js        快取的對外介面（SQL 在 db/translations.js）
queue.js        背景佇列
crawl-links.js  一頁裡可以爬的路徑
crawl.js        預先翻譯整站
service.js      門面：代理叫的就是這支
```

### 改造一頁怎麼走（v5）

```
proxy/respond.js → rules/service.js applyToHtml()   ← 同步，跟翻譯層同一套紀律
  → compile.js    DB 的列 → 可執行的規則（壞規則帶著 error 回去，不丟例外）
  → apply.js      segmentHtml(ancestors) → splitEdges → decodeEntities
                  → text.js 依序套規則 → encodeEntities → 座標回填
  → hide-css.js   選擇器 → `display: none !important`
  → style-tag.js  插在 </head> 之前（零閃爍，又贏得過站內的 !important）
```

資源覆寫（換 logo / 換圖）**不在這條管線上** —— 它在 `proxy/handler.js` 的
最前面（`proxy/resource-override.js`）：命中就直接回使用者上傳的檔案，
SSRF、讀 body、forward 全部省掉。

```
src/rules/
  selector.js     hide 的 CSS 選擇器檢查 + 非 ASCII 跳脫
  css-text.js     css 規則的 CSS 文字檢查（擋 </style）+ 非 ASCII 跳脫
  scope.js        文字規則的範圍限定（祖先鏈比對，CSS 選擇器的子集）
  user-regex.js   使用者正則的編譯 + 嵌套量詞攔截
  literal.js      字面取代（空白寬鬆、大小寫風格跟著原文）
  compile.js      DB 的列 → 可執行的規則 / 一條錯誤訊息
  text.js         單段套規則 + 跨段的時間預算
  apply.js        整份 HTML 的座標回填
  hide-css.js     hide + css → 一份 CSS（順序照 order_index，後者勝）
  style-tag.js    注入 <style>
  image-refs.js   候選圖（img src / srcset / CSS url()）
  service.js      門面：代理與控制台叫的都是這支
  presets/        使用者實際要求的那幾組規則（**資料**，不是引擎）
```

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

## 資料模型（v4 新增）

```
translations     hash(PK) / source_text / target_lang / model / translated
                 origin('machine'|'manual') / created_at / updated_at
translate_queue  hash(PK) / source_text / target_lang / model / site_id
                 attempts / last_error / created_at
crawl_jobs       id(PK) / site_id / status / start_path / max_pages / max_depth
                 pages_done / pages_found / segments_new / last_error / 時間
sites            + translate_enabled / translate_lang / translate_model / glossary
```

- **`translations` 是主幹不是優化。** 靜態內容不常變 → 翻一次永久有效。
  `hash` 含 model，所以**換模型會自動重翻**，舊的留著（可以比較、可以回退）。
- **`origin='manual'` 永遠優先，而且在兩個地方都要成立**：寫入時
  `ON CONFLICT DO UPDATE … WHERE origin <> 'manual'`，讀取時 manual 壓過 machine
  （**跨模型也算** —— 不然換個模型就把人工改過的譯文丟了）。
- **`translate_queue.site_id` 刻意不是外鍵。** 它只為了 UI 分組，刪站不該連帶砍掉
  待翻的段；而且沒有外鍵，`INSERT OR IGNORE` 的語意才乾淨（地雷 15 講的是有外鍵時
  會把違規一起吞掉）。
- **`sites.translate_model` 是 NULL 時代表「用全域預設」**，DB 層原樣轉述不套預設值 ——
  套了的話 UI 分不出「使用者選了這個」與「跟著全域走」。
- `glossary` 存 JSON 陣列（跟 `script_sites.exclude_glob` 同一個做法），
  讀寫一律走 `translate/glossary.js` 的 `parseGlossary` / `serializeGlossary`。

## 資料模型（v5 新增）

```
site_rules          id / site_id / kind('hide'|'css'|'text-replace'|'text-rewrite')
                    pattern / replacement / scope / note / enabled / order_index
resource_overrides  id / site_id / path / sha256 → assets / content_type / enabled
                    UNIQUE(site_id, path)
sites               + dev_mode（v6）
```

- **`scope` 不在規格 §2 的欄位表裡** —— 它是 §3.2 追加的：卡片標題那條規則
  全站套會把「2026 年的…」一起改掉。空的 scope ＝ 全站。
- **`resource_overrides.sha256` 是指向 `assets` 的外鍵。** 覆寫指到不存在的
  檔案的話，使用者看到的是「換了圖但圖破了」，而那時候已經來不及知道原因。
- **`replacement` 的空字串有意義**（把一段文字刪掉，footer 的孤兒分隔符就靠它），
  所以 DB 層不把它折成 null。
- 規則**每個請求重讀 + 重編譯**：改了立刻生效，而且 `RegExp` 的 `lastIndex`
  不會跨請求活著。
- **`kind='css'` 的 `pattern` 存的是一整段 CSS 文字，不是選擇器**（v6）。
  所以它可以含換行、上限是 4000 字（其他型別 500），而且驗證層**不**擋
  `</style>`（規格 §4 要壞規則存得起來並標紅）—— 真正的防線在 `rules/css-text.js`。
- **`sites.dev_mode` 是「反覆調規則時打開、調完關掉」的開關，不是常駐狀態**。
  打開時所有非 HTML 回應改成 `no-cache`（保留 ETag）。
- **v6 的 migration 重建了整張 `site_rules`**（`kind` 的 CHECK 寫在建表語句裡，
  SQLite 不能 ALTER）。順序照地雷 11：rename → 建新表 → 複製 → 最後才 DROP。

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

### v4（翻譯層）踩到的

35. **⛔ 一批失敗就 `break` 出佇列迴圈 ＝ 整站永遠停在那裡。**
    第一版的 `queue.js` 在「整批失敗且下一批是同一批」時直接跳出迴圈（想避免原地
    打轉）。實測（templatemo 整站 85 段）：ollama 冷啟動那一下逾時之後，**85 段全部
    卡住不動**，控制台顯示「待翻 85」再也不會變，而且不會再出現任何錯誤訊息 ——
    一次暫時性的逾時讓整個功能靜默死亡。
    正解是把失敗的那批記進 `exclude` 然後**繼續做下一批**（`claimQueue` 支援
    `exclude`）。原地打轉與整站停擺是兩個問題，不要用同一個 `break` 解。
    有兩條測試釘著（「一批失敗不會把整條佇列卡死」「同一輪裡不會重複拿到剛失敗的那批」）。
36. **逾時不是「連不上」，訊息混在一起會害人查錯方向。** 第一版的 catch 把所有 fetch
    失敗都寫成「連不到 ollama」。實際情形是 ollama 好好的、只是冷啟動慢 ——
    log 卻叫你去檢查一個沒壞的東西。現在分開了（`TimeoutError` / abort 走另一句）。
37. **規格的「batch 20」是用短 UI 字串量的。** 真實頁面有整段文章。實測
    templatemo 的 85 段共 4046 字元：**熱的時候 batch 20 要 5.2 秒**（259ms/段），
    而冷啟動那一次直接撞到 120 秒逾時。數字本身沒問題（整站 85 段 12 秒清空），
    但要知道「20 段」的成本跟那 20 段有多長成正比，不是固定的。
38. **測試裡的無界 `while` 會把整個 test run 吊死。** 爬蟲的取消測試原本寫
    `while (requests.length < 1) await sleep(10)` 等第一個請求 —— 當路由因為別的 bug
    回 404 時，那個迴圈永遠不會結束，而 `node --test` 的輸出被管線緩衝住，
    看起來像「測試整個沒反應」而不是「有一條測試失敗」。等待迴圈一律要有 deadline。
39. **新的子 router 要一路轉下去才會生效。** `createTranslateApiRouter` 掛在
    `admin-api.js`，但 `admin-page.js` 的 `createAdminRouter` 沒把 `crawler` 往下傳 →
    `if (translation && crawler)` 不成立 → **所有 `/crawl` 端點靜默 404**。
    加新依賴時 `app.js` → `admin-page.js` → `admin-api.js` 三層都要改。
40. **⛔ 「跑完一輪再排下一輪」解決不了「誰來開始第一輪」。**
    佇列存在 DB 裡，所以它活過重啟。我先做了「一輪結束後若還有待翻就排重試」，
    然後重現使用者的卡住狀態、起 server、**四分鐘完全不動** —— 因為從來沒有
    第一輪。`queue.resume()`（在 `createTranslationService` 裡呼叫）才是解法。
    任何「做完 A 之後接著做 B」的鏈條，都要另外問一次「**A 第一次是誰觸發的**」。
41. **同一個專案裡 `unref()` 有兩種相反的正確答案。** 佇列的重試計時器**要**
    unref（伺服器有 HTTP handle 撐著，但測試與 CLI 不該被它吊住）；ollama 的逾時
    計時器**不准** unref（那時候正好沒有別的東西撐著 event loop，unref 了就不會醒）。
    判準是「這個計時器該醒的時候，還有別的東西撐著 event loop 嗎」。
42. **叫模型寫「繁體中文」不夠，要把「禁止簡體字」講死。** 使用者快取的 85 段裡
    有 1 段是簡繁混雜（「發現超过620个免费的…」），而中招的剛好是首頁最大那塊文案。
    加一條規則之後，同一段實測 3/3 全繁體。

### v5（改造規則）踩到的

43. **⛔ 講死了也沒用：「禁止簡體」要在收貨的時候驗，不能只寫在 prompt 裡。**
    實測（2026-11-18 對使用者真的快取跑一次重翻）：13 段重翻完**還剩 8 段是簡體**
    —— qwen2.5 就是會把 `Lantern River` 翻成「灯笼河」，prompt 裡寫了也一樣。
    而翻譯快取是**永久**的，寫進去就等於永久錯下去。
    現在 `queue.js` 收到譯文會先過 `findSimplified()`，有簡體就當成 `alignment`
    失敗（二分 → 單段 → attempts += 1 → 三次後進「翻不動」清單讓人工處理）。
    ⛔ 這個檢查**只在目標語言是繁體時**生效（`wantsTraditional`）——
    使用者把 `translate_lang` 設成 `zh-CN` 時，簡體字才是對的答案。
44. **⛔ 簡體偵測的字表不要用手寫的。** 手寫的第一版漏了「灯」「笼」「动」，
    於是「掃出 0 段」變成一個**假答案** —— 比沒做還糟。
    `src/translate/simplified-chars.js` 是 `scripts/generate-simplified-chars.ps1`
    拿 Windows 自己的簡繁轉換表（`Microsoft.VisualBasic.Strings.StrConv`）掃出來的
    8873 個碼位，再用兩份小清單修邊：排除 `台`（台灣 / 控制台 / 平台 在繁體裡天天用，
    不排除幾乎每個站都誤判）、補上 `么`（什么 / 怎么 —— 兩邊都是合法字，轉換表動不了）。
45. **⛔ 規則的 scope 只配了清單頁的容器 → 詳情頁完全沒變，而且測試全綠。**
    templatemo 的卡片在清單頁是 `.thumbnail_270`，在詳情頁底下那排「More Website
    Templates」卻是 `.tm_silver_360`。curl 與單元測試都不會發現 —— 它們不會
    「順手往下滑一頁」。**規則配完一定要把每一種頁面都開過一遍**。
    （現在 `tests/integration/rules-templatemo.test.js` 有一條釘著詳情頁。）
46. **⛔ 加了資源覆寫，瀏覽器裡還是舊的那張圖 —— 而伺服器端一切正常。**
    代理對**非 HTML** 的回應是照抄上游快取指示的（那是效能的來源），所以
    templatemo 的 `max-age=86400` 會讓瀏覽器整整一天不來問我們。覆寫本身回
    `no-store`，但那只對「瀏覽器真的來問」的時候有用。
    實測現場：`fetch(url, {cache:'no-store'})` 拿到 1278 bytes 的新圖，
    同一頁的 `<img>` 卻是 9982 bytes 的舊圖。
    **這是地雷 33 的變體，差別在於它連 `curl` 都看起來是對的。**
    控制台上傳完會提示按 Ctrl+F5；沒有辦法從伺服器端回頭清掉瀏覽器已經存下的那份。
47. **`hide` 規則的命中數不要在伺服器端算。** 那需要真的 CSS 比對，而伺服器端
    沒有 DOM（切段器是狀態機）。控制台的「試一下」是抓一份**代理過的同源頁面**
    丟 `DOMParser` + `querySelectorAll` —— 瀏覽器自己就有完整的 CSS 引擎。
    `scope` 的比對是另一回事：那是祖先鏈上的子集比對，看不懂的語法一律拒絕
    （猜錯的後果是「規則悄悄套到全站」，比沒生效嚴重得多）。

### v6（cache busting / `css` 規則）踩到的

48. **⛔ 地雷 46 的真正解法不是「叫使用者按 Ctrl+F5」。** 覆寫的回應是
    `no-store` 沒錯，但那只對「瀏覽器真的來問我們」的時候有用 —— 而 templatemo
    的圖片帶 `max-age=604800`，瀏覽器**七天內不會來問**。
    正解是讓網址本身變成內容定址的：`?v=<sha256 前 8 碼>`（`lib/cache-bust.js`）。
    換圖 → sha 變 → 網址變 → 舊快取那一筆再也不會被用到。
    **判準**：凡是「我們這邊換了東西，但瀏覽器手上那份是舊的」的問題，
    能改網址就改網址，不要去改快取指示 —— 後者治不了「它根本沒來問」。
49. **`lib/html.js` 不改寫 `url()` 裡的網址。** 它只動
    `src`/`href`/`action`/`poster`/`formaction` 這幾個屬性，所以
    `style="background:url(/images/logo.png)"` 在送出去的 HTML 裡是**沒有
    `/p/<site>/` 前綴的根絕對路徑**（由根路徑 fallback 接住）。
    任何「掃 HTML 裡的資源引用」的新程式碼都要同時認這兩種形狀 ——
    只認代理路徑的話，`background-image` 的 logo 會整組漏掉。
50. **同一份 HTML 裡有兩種 entity 規則。** 屬性值（`src="…"`）會被解碼，
    `<style>` 裡的 raw text **不會**。所以產生網址時分隔符要用裸的 `&`
    （`&amp;` 在 CSS 那邊會變成真的字面字元 → 404，而且只有 background-image
    會壞）。寫任何「同時改屬性與 CSS」的函式之前先想這件事。
51. **⛔ `escapeCssNonAscii` 不能直接拿去跳脫「一整段 CSS」。** 它擋的是
    `[^\x20-\x7e]`，而那個範圍含 `\n` 與 `\t` —— 多行 CSS 會被寫成
    `.a {\00000a  margin: 0;}`，整份報廢，而且**不會報錯**。
    `rules/css-text.js` 的 `escapeCssText` 保留 `\t` / `\r` / `\n`。
52. **`<style>` 的唯一出口是 `</style`，所以 `css` 規則只要擋這一個就夠。**
    `{` `}` `;` `\` 全部要放行（CSS 沒有它們就不是 CSS），而 `<\/style>` 在 HTML
    分詞器眼裡不是結束標籤。擋的時候大小寫與空白的變形都要涵蓋
    （`</STYLE>`、`</style   >`、`</style/`）。
53. **⛔ `applyPreset` 的「同一條規則」不能用 pattern 認 `css` 規則。**
    `css` 的 pattern **就是被編輯的內容本身** —— 把 logo 的 font-size 從 46px
    調成 54px 再重跑 seed，結果是**新增一條**而不是更新：兩條同時注入，誰贏看
    `order_index`，舊的那條還活著。`css` 的身分改用 `note`。
    （一般原則：拿「會被編輯的內容」當身分一定會長出重複。）
54. **⛔ 「`display:none` 會留下容器的高度與 margin」是個很好用但常常錯的假設。**
    templatemo 的那片空白實測**不是**那樣來的：`.tm-dl-grey` 這些容器的子元素
    都是 float，它們本來就 0 高。真正的來源是兩個 `min-height: 300px` 的空廣告位。
    **量，不要推論**：`[...document.querySelectorAll('body *')]` 濾出
    「高度 ≥ 40px 但 textContent 是空的」就直接指出兇手了。
55. **翻譯漏了某幾段時，先確認它們有沒有進過佇列。** `Added:` / `Views:` /
    `Downloads:` 永遠是英文，而同一行的日期翻好了 —— 看起來像模型漏翻，實際上
    是 `translate/rules.js` 的 URL 判斷把 `Added:` 當成 URL scheme，那三段
    **從來沒被收進去**。查的順序是：`isTranslatable()` → `translate_queue`
    → `translations`，不是倒過來。

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

---

## 翻譯層的設計決策（v4，以及為什麼）

- **`translateHtml()` 是同步的，而且刻意沒有 async 版本。** 只要它能 await，
  就一定有人會在請求路徑上等 ollama —— 那是 18 秒的首次載入，而不是零閃爍。
  請求路徑只做一次批次 SQLite 查詢；沒命中就保留原文、丟進背景佇列。
  **使用者第一次看到部分英文是預期行為，不是 bug。**
- **只有明確宣告 UTF-8 的文件才翻**（`translate/charset.js`）。
  HTML 改寫全程走 latin1（byte-lossless），v1~v3 從來不用管 charset，因為插進去的
  東西全是 ASCII。**翻譯會插入中文**，而中文的 byte 表示法跟頁面宣告的編碼綁在一起：
  把 UTF-8 的 byte 插進一份宣告 Big5 的頁面，使用者看到的是亂碼。沒宣告的也不翻
  （瀏覽器會自己猜）。**規格沒提這件事，這是實作時補上的安全邊界。**
- **請求模型回「索引當 key 的 object」，不是陣列。** 規格 §1 的實測：要陣列時
  模型會回 object 而且**整批錯位**（第一段的譯文被拿去當 key）。
  **錯位比翻錯危險得多** —— 每一段看起來都有翻，不會有人發現，而且會進永久快取。
- **對齊防呆：任何一條不符就整批丟棄。** 是 object、key 剛好 `"0"`..`"n-1"`、
  每個 value 是非空字串。這段有退化驗證（把檢查拿掉，24 條裡有 9 條變紅）。
- **⛔ 對不上要二分，不要「固定批次重試三次」。** 實測（2026-11-18 對真的
  templatemo）：**20 段的批次，qwen2.5 回了 35 個 key**。規格的「批次 20」是從
  「10 段實測完美」外推的，那個外推錯了。固定批次 + 整批記 attempts 的語意是
  **19 個好段被 1 個壞段連坐**，三輪之後那 19 段也一起被標成翻不動。
- **⛔ 只有「模型的答案錯了」才二分，「沒拿到答案」不二分。** 逾時一次要等 120 秒，
  遞迴二分 20 段會變成 39 次逾時 ＝ 一個多小時。而逾時最常見的原因是冷啟動，
  收手、下一次 kick 時模型已經熱了就過了。
- **⛔ 基礎設施的失敗不准燒掉段落的重試額度。** ollama 關一小時，不該讓整站的段落
  都被標成「翻不動」—— 那些段落可能一個問題都沒有。`recordFailure` 的
  `countAttempt: false` 就是這件事（原因照樣寫進 `last_error` 給 UI 看）。
- **hash 用長度前綴，不是規格寫的換行分隔。** 規格的
  `sha256(原文 + '\n' + lang + '\n' + model)` 會讓 `('a','b\nzh')` 與 `('a\nb','zh')`
  撞成同一個 hash ＝某一段拿到另一段的譯文。實務上撞不到（原文的換行已經被
  `normalizeSpace` 壓掉），但擋掉它的成本是三個數字。
- **ollama 的呼叫不走 SSRF 防護。** 那是**伺服器自己發起**的呼叫，不是使用者腳本
  發起的。**不要**為了翻譯去打開 `LOCALMONKEY_ALLOW_PRIVATE`（那是代理目標的全域
  開關，打開等於讓所有被代理的站都能指向內網），也跟 `LOCALMONKEY_GM_ALLOW_HOSTS` 無關。
- **切段器保證 `html.slice(start, end) === raw`。** 回填直接拿座標切字串，所以座標
  是契約。有一條測試專門釘這件事 —— 座標錯掉的症狀是版面爆開，而 curl 看起來
  「有翻譯」。
- **SQL 在 `db/translations.js`，不在 `translate/cache.js`。** 規格 §4 把 cache 列在
  `src/translate/` 底下，但這個專案所有資料表的讀寫都在 `src/db/`，翻譯沒有理由當例外。
  `translate/cache.js` 留著當對外介面（hash + resolve），責任跟規格寫的一致。
- **爬蟲的禮貌間隔只准往上調。** `LOCALMONKEY_CRAWL_POLITENESS_MS` 的下限就是預設值
  500ms —— 這是在打**別人的**伺服器，往下調就是把功能變成壓測工具。
- **文字規則只套在宣告 UTF-8 的文件上，`hide` 不受這個限制。** 理由跟翻譯層
  一模一樣（`translate/charset.js`）：使用者寫的替換字幾乎都含中文，插進一份
  宣告 Big5 的頁面就是亂碼。`hide` 的選擇器已經被跳脫成純 ASCII，所以不受影響。
  控制台的「試一下」會把 `charset_ok: false` 講出來 —— 不然「寫了沒反應」
  這個症狀完全猜不到原因。
- **文字規則只動切段器切出來的文字段。** `href` / `src` / `class` / `id` /
  `data-*` 從來不在切段結果裡，所以結構上不可能被改到（`tests/unit/rules-apply.test.js`
  與 templatemo 的整組規則各有一條回歸測試釘著）。
- **使用者的正則有三層保護，缺一不可**（`rules/user-regex.js`）：編譯時擋掉
  嵌套量詞（`(a+)+`、`(a|aa)+` 這種指數級回溯的形狀）、不把超過 2000 字的段
  餵進去、跨段累計時間預算超了就停用那條規則。JS 的正則比對是**同步而且不可
  中斷**的，所以沒有第四種辦法 —— 真的跑進去了就只能等它跑完。
- **壞規則不丟例外，帶著 `error` 回去。** 控制台要把那一列標紅並說明原因，
  而代理要照常回應 —— 一條規則寫壞不該讓整個網站打不開。所以 API 也**收**
  編譯不過的規則（退回去的話使用者只會看到一個 400，沒有上下文可以改）。
- **資源覆寫的網址帶內容雜湊（`?v=`），而覆寫本身的快取政策跟著它走**（v6）：
  `?v=` 對得上就回 `immutable`（內容定址，網址只會對應到這一份內容），
  沒帶或帶錯就回 `no-store`。`dev_mode` 打開時一律 `no-cache`。
  **只有有覆寫的路徑會被加上 `?v=`** —— 其他資源一個都不碰，不然等於把整站快取關掉。
- **資源覆寫上傳的 content-type 以「聞出來的」為準**（magic bytes），不是宣告的
  —— 宣告是使用者可控的字串。**SVG 一律拒絕**：它可以內嵌 `<script>`，而那張圖
  是從我們自己的 origin 送出去的（同 `safeAssetContentType` 與 favicon 的理由）。
- **翻完才改 `<html lang>`。** 一份還是英文的頁面不該宣告自己是中文。
  （為什麼要改：`lang` 決定瀏覽器挑哪套 CJK 字體，`lang="en"` 的中文頁面常常被畫成
  日文字形。這是驗收時在真瀏覽器上看到的，規格沒提。）
