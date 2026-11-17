# LocalMonkey v4 — 伺服器端翻譯層

> 2026-11-18。前面三份仍然有效：`SPEC.md`（v1 代理核心）、`SPEC-console.md`（v2 控制台 + 投遞）、`SPEC-dashboard.md`（v3 儀表板 + `<base>` + 快取）。
> 這份加一個**新的改造層**：代理在 HTML 出門前把文字翻成繁體中文。

---

## 0. 為什麼在伺服器端做

使用者原話：「我想要他翻譯成中文」「我們有本地 AI 可以先翻譯啊」「這種靜態資源又不會變動太多?」

他說對了兩件事，而且那兩件事決定了整個設計：

1. **本地 LLM** → 不用 API key、不用錢、**內容不會送出去**。機器翻譯的三個反對理由一次消失。
2. **靜態內容不常變** → 翻一次就永久有效。**快取不是優化，是主幹。**

在伺服器端做（而不是注入 JS 用 TreeWalker）的理由是**零閃爍**：送到瀏覽器的 HTML 本來就是中文的，不會英文先閃一下再被換掉。代價是伺服器端沒有 DOM，要自己切文字段（見 §3），但那比閃爍可接受。

前端渲染出來的動態內容這一期**不處理**，之後用注入腳本補。

---

## 1. 實測數據（2026-11-18 在這台量的，照這個設計，別重新調查）

模型 `qwen2.5:latest`（7.6B Q4_K_M，32k context），ollama 在 `http://127.0.0.1:11434`。

| 條件 | 結果 |
|---|---|
| 模型冷啟動（載 4.7GB） | **約 45 秒**，只有第一次 |
| 熱的時候 | **52 tok/s**，約 **221 ms/段** |
| 10 段一批 | 2.2 秒 |
| 整頁 80 段估計 | 約 18 秒 |

### ⛔ 最重要的一個實測結果：不要用 JSON 陣列

要求模型回 JSON **陣列**時，它回了 object，而且**整批錯位**——第一段的翻譯被拿去當 key，value 變成第二段的翻譯。

**錯位比翻錯危險得多**，因為每一段看起來都「有翻」，不會有人發現。

改成**索引當 key 的 object**（`{"0": "...", "1": "..."}`）就穩了，實測 10/10 對齊。

所以：
- 請求格式：`{"0": "原文", "1": "原文", ...}`
- `format: "json"`、`temperature: 0`
- **回來的 key 數量或型別對不上 → 整批丟棄、退回原文**，絕不硬塞。這條要有測試，而且要做退化驗證。

品質實測可用：術語（HTML / CSS / Bootstrap / Claude / ChatGPT）全部保住、`620+` 保住、`Contact` → 「聯絡我們」（UI 用語正確）。

---

## 2. 資料模型（migration 往上加一版）

```
translations                     -- 翻譯快取，整個設計的主幹
  hash          TEXT PRIMARY KEY -- sha256(原文 + '\n' + target_lang + '\n' + model)
  source_text   TEXT NOT NULL
  target_lang   TEXT NOT NULL    -- 'zh-TW'
  model         TEXT NOT NULL    -- 'qwen2.5:latest'
  translated    TEXT NOT NULL
  origin        TEXT NOT NULL    -- 'machine' | 'manual'
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL

translate_queue                  -- 還沒翻的段（背景處理）
  hash          TEXT PRIMARY KEY
  source_text   TEXT NOT NULL
  target_lang   TEXT NOT NULL
  model         TEXT NOT NULL
  site_id       TEXT             -- 哪個站先遇到的（只為了 UI 分組）
  attempts      INTEGER NOT NULL DEFAULT 0
  last_error    TEXT
  created_at    TEXT NOT NULL

crawl_jobs                       -- 「預先翻譯整站」的工作
  id            TEXT PRIMARY KEY
  site_id       TEXT NOT NULL
  status        TEXT NOT NULL    -- 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  start_path    TEXT NOT NULL
  max_pages     INTEGER NOT NULL
  max_depth     INTEGER NOT NULL
  pages_done    INTEGER NOT NULL DEFAULT 0
  pages_found   INTEGER NOT NULL DEFAULT 0
  segments_new  INTEGER NOT NULL DEFAULT 0
  last_error    TEXT
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL
```

`sites` 加欄位：
```
  translate_enabled  INTEGER NOT NULL DEFAULT 0
  translate_lang     TEXT NOT NULL DEFAULT 'zh-TW'
  translate_model    TEXT                      -- NULL = 用全域預設
  glossary           TEXT                      -- JSON 陣列，不准翻的詞
```

**`hash` 含 model**，所以換模型會自動重翻，舊的留著不刪（可以比較、可以回退）。

**`origin='manual'` 永遠優先**：人工改過的那段，背景翻譯不准覆蓋。

---

## 3. HTML 文字切段（伺服器端，沒有 DOM）

**不要引入 HTML parser**（會打破零依賴）。寫一個狀態機掃描器就夠了，約 100–150 行，跟現有的 HTML 改寫（latin1 往返）同一套路數。

規則：

- 追蹤目前在不在「跳過區」：`<script>`、`<style>`、`<pre>`、`<code>`、`<textarea>`、`<svg>`、HTML 註解
- 跳過區之外，`>` 與 `<` 之間的文字就是一段
- 連續空白正規化後比對；**回填時要保留原本的前後空白**（不然版面會垮）

### 不翻的段（漏了會出事）

- 空白、純數字、純符號
- 長度 < 2 字元
- URL、email（整段看起來是的）
- **已經含中日韓字元的**（避免二次翻譯把中文翻壞）
- 在術語表裡的整段

### HTML entity

**先還原再翻、翻完再編碼**。不然 `&amp;` 會被當文字翻掉、`&nbsp;` 會消失。
至少處理 `&amp; &lt; &gt; &quot; &#39; &nbsp;`，其餘保持原樣不動。

### 屬性也要翻

`alt`、`title`、`placeholder`、`aria-label` —— 這些不是文字節點，要另外一條路處理。
`<meta name="description">` 與 `<title>` 也翻。

**不准碰**任何 `href`、`src`、`class`、`id`、`data-*`。

---

## 4. 翻譯服務（`src/translate/`）

```
segment.js    HTML → 文字段清單（純函式，吃字串吐陣列，不碰 DB/網路）
restore.js    段清單 + 翻譯對照 → 回填成 HTML（純函式）
ollama.js     批次呼叫 ollama（索引 key、temperature 0、對齊檢查）
glossary.js   術語保護
cache.js      translations 表的讀寫（manual 優先）
queue.js      背景翻譯佇列（序列化，ollama 本來就不併行）
```

純函式的部分要測得密——它們是最容易出錯又最好測的地方。

### ollama 呼叫

- 端點 `POST {OLLAMA_URL}/api/generate`，`model`、`format:"json"`、`stream:false`、`options:{temperature:0}`
- 批次 **20 段**（實測 10 段 2.2 秒，20 段仍在可接受範圍）
- `keep_alive: "30m"` —— 不然每隔一陣子就要再吃 45 秒冷啟動
- **逾時**：每批 120 秒。`AbortSignal.timeout` **外加** `Promise.race`（node 的 fetch 不保證理會 signal）
- ollama 連不上 → 不要讓代理掛掉。記 `last_error`、佇列保留、UI 顯示「翻譯服務連不上」

### 對齊防呆（必測 + 退化驗證）

回來的結果必須：是 object、key 剛好是 `"0"`..`"n-1"`、每個 value 是非空字串。
**任何一條不符 → 整批丟棄**，`attempts += 1`，保留原文。

`attempts >= 3` 的段標記成翻不動，UI 顯示出來讓人工處理，不要無限重試。

---

## 5. 請求時的行為（零閃爍的關鍵）

```
代理收到 HTML 且該站 translate_enabled
  → segment()
  → 批次查 translations 快取
      命中 → 用（manual 優先於 machine）
      沒命中 → 保留原文 + 丟進 translate_queue
  → restore() 回填
  → 送出
```

**查快取是同步的 SQLite 查詢，不會拖慢代理。** 絕對不要在請求路徑上等 ollama。

背景佇列獨立跑，翻完寫進 `translations`，**下次載入就是中文**。

---

## 6. 預先翻譯整站（爬蟲）

`POST /admin/api/sites/:id/crawl` `{ startPath?, maxPages?, maxDepth? }`

- 預設 `maxPages: 50`、`maxDepth: 3`，上限 `maxPages: 500`
- **只爬同一個 target_origin**，只跟 `<a href>`，跳過有副檔名的非 HTML（`.pdf`/`.zip`/`.jpg`…）、跳過 `#` 錨點與 query 不同但路徑相同的
- **禮貌**：同時只打 1 個請求、每個請求之間至少 **500ms**。這是在打別人的伺服器，不要變成壓測
- 已經在 `translations` 裡的段**跳過**，所以重跑很便宜
- 可以 `POST .../crawl/:jobId/cancel` 中止；中止要立刻生效（不是跑完這一輪）
- 進度寫進 `crawl_jobs`，UI 要顯示：找到幾頁 / 做完幾頁 / 新增幾段 / 預估剩餘時間（用實測的 221ms/段 推）

**啟動時要先確認 ollama 活著**，連不上就直接回錯誤，不要讓使用者按完等半天才發現。

---

## 7. 控制台 UI

### 站台的翻譯設定（網站分頁展開）
- 翻譯開關、目標語言（預設 `zh-TW`）、模型（下拉，從 `GET {ollama}/api/tags` 撈）
- 術語表編輯（一行一個詞，預設帶 `HTML CSS JS Bootstrap Tailwind React Vue AI API URL SEO` 之類）
- 「**預先翻譯整站**」按鈕 + 進度條 + 取消

### 新的「翻譯」分頁
- 表格：原文 / 譯文 / 來源（機器 / 人工）/ 站台 / 更新時間
- 搜尋（原文與譯文都要能搜）
- **人工覆寫**：點譯文直接改，存檔後 `origin='manual'`
- 單段「重翻」
- 篩選「翻不動的」（`attempts >= 3`）
- 佇列狀態：還有幾段待翻、ollama 活著沒

---

## 8. 設定

```
LOCALMONKEY_OLLAMA_URL      預設 http://127.0.0.1:11434
LOCALMONKEY_TRANSLATE_MODEL 預設 qwen2.5:latest
LOCALMONKEY_TRANSLATE_BATCH 預設 20
LOCALMONKEY_TRANSLATE_KEEPALIVE 預設 30m
```

**ollama 是 localhost**，所以 §4 的呼叫會撞到現有的 SSRF 防護。
**不要**因此打開 `LOCALMONKEY_ALLOW_PRIVATE`（那是代理目標用的）。
這是**伺服器自己發起**的呼叫，不是使用者腳本發起的，走獨立路徑、獨立設定，跟 `LOCALMONKEY_GM_ALLOW_HOSTS` 也沒關係。

---

## 9. 測試

- **切段**：跳過 script/style/pre/code/svg/註解；保留前後空白；entity 還原與重新編碼；巢狀標籤；沒有結束標籤的壞 HTML 不會爆
- **不翻的規則**：純數字、URL、email、太短、已含中日韓字元、術語表命中
- **屬性**：`alt`/`title`/`placeholder`/`aria-label`/`<title>`/`meta description` 有翻；`href`/`src`/`class` **沒被動到**（這條是防止過度修正的回歸保護）
- **對齊防呆**（最重要，要退化驗證）：
  - key 少一個 → 整批退回原文
  - key 多一個 → 整批退回原文
  - value 是數字/null → 整批退回原文
  - 模型回陣列（實測會發生）→ 整批退回原文
  - 退化驗證：把對齊檢查拿掉，上面這些要真的變紅
- **manual 優先**：同一段有 machine 也有 manual → 用 manual；背景翻譯不覆蓋 manual
- **快取**：同一段第二次不會再呼叫 ollama（注入假的 ollama client 數呼叫次數）
- **ollama 掛掉**：代理仍然正常回應（原文），錯誤被記錄，不會 500
- **爬蟲**：只爬同源、深度上限、頁數上限、跳過非 HTML、cancel 立刻生效、已快取的段不重排
- **既有測試全綠**（目前 772+）

---

## 10. 完成的定義

1. `npm test` 全綠、覆蓋率 ≥80%，貼實際輸出
2. 對齊防呆的退化驗證做過並貼結果
3. **真的用瀏覽器開 `http://127.0.0.1:30612/p/templatemo-com/`**：第一次看到部分英文（背景在翻），等佇列清空後重新載入，**整頁是繁體中文且版面沒跑掉**。截圖
4. 「預先翻譯整站」跑一次（`maxPages: 5` 即可），進度有動、可以取消
5. commit + push

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，不准任何 Claude / Co-Authored-By 署名。
