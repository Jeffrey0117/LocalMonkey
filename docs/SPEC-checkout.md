# 重繪 v3 — 單筆結帳（藍新 MPG）

> 2026-11-19。接續 `SPEC-reskin.md`(v7) 與 `SPEC-reskin-v2.md`。
> 這份把「立即購買」從前端示範接成**真的金流**。

---

## 0. 使用者的決定與前提

> 「這個站沒有部署　金流用真實的　我自己要測試的　沒人能刷到」

所以：**支援正式環境**，但有三條前提寫在這裡，實作要照著做。

### 0.1 金鑰不經過任何人之手

商家金鑰（MerchantID / HashKey / HashIV）**由使用者自己填進 `.env`**。

- 程式碼只從 env 讀，**不准有任何預設值、不准有範例金鑰**
- 金鑰**絕對不准**出現在前端、HTML、log、錯誤訊息裡
- `.env.example` 只寫鍵名與說明，**不寫值**
- 啟動時若偵測到金鑰疑似被寫進程式碼（硬編在 `src/` 下），要大聲警告

### 0.2 ⛔ localhost 收不到 NotifyURL

| 回呼 | 在 localhost 可行嗎 |
|---|---|
| `ReturnURL`（付完瀏覽器跳回） | ✅ 可以，瀏覽器就在本機 |
| `NotifyURL`（藍新伺服器主動 POST） | ❌ **不行**，藍新打不到 `127.0.0.1` |

所以本期的訂單確認**只能靠 ReturnURL 帶回來的加密結果**。

**這在正式站是不夠的**（使用者付完關掉瀏覽器就收不到結果），必須：
- 在 `.env.example`、README、以及控制台的金流設定區**明確寫出這個限制**
- 不要假裝它是完整實作

### 0.3 單筆買斷，不是訂閱

PayGate 是**訂閱帳本**（實測 `/api/plans` 回的是 `keybox:standard:monthly` 這種，串的是藍新**定期定額**）。

目前的 UI 是「一套模板 NT$199、立即購買」＝**單筆買斷**，要走藍新 **MPG 幕前支付**，不是 PayGate。

→ 本期**不接 PayGate**。之後若改成會員訂閱再回頭接。

---

## 1. 環境變數

```
LOCALMONKEY_NEWEBPAY_ENV           test | live     （預設 test）
LOCALMONKEY_NEWEBPAY_MERCHANT_ID
LOCALMONKEY_NEWEBPAY_HASH_KEY
LOCALMONKEY_NEWEBPAY_HASH_IV
LOCALMONKEY_PUBLIC_URL             回呼用的對外網址（預設 http://127.0.0.1:<port>）
```

端點：
- test → `https://ccore.newebpay.com/MPG/mpg_gateway`
- live → `https://core.newebpay.com/MPG/mpg_gateway`

**缺任何一個必填值 → 維持示範模式**，購買列照舊顯示「未接金流（示範模式）」，不要讓人按到壞掉的按鈕。

`ENV=live` 時，購買列的狀態標示要是**明確的警告色**並寫「**正式環境（會真的扣款）**」。使用者自己說要用正式，但按下去之前必須看得到。

---

## 2. 流程

```
立即購買
  → POST /p/<site>/__reskin/checkout   { productId, qty }
      伺服器端：組訂單 → AES-256-CBC 加密 TradeInfo → SHA256 算 TradeSha
      回傳一張 auto-submit 的表單（或回參數讓前端送出）
  → 瀏覽器 POST 到藍新 MPG
  → 使用者付款
  → 藍新 POST 回 ReturnURL  /p/<site>/__reskin/checkout/return
      伺服器端：解密 TradeInfo → **驗 TradeSha** → 比對訂單 → 更新狀態
  → 渲染我們自己的成功/失敗頁
```

### 2.1 加密（照藍新 MPG 規格，不要自己發明）

- `TradeInfo`：查詢字串格式 → **AES-256-CBC**（key=HashKey、iv=HashIV、PKCS7）→ hex
- `TradeSha`：`HashKey=<key>&<TradeInfo>&HashIV=<iv>` → **SHA256 → 大寫 hex**
- `Version`、`MerchantOrderNo`、`Amt`、`ItemDesc`、`TimeStamp` 照規格

⚠️ `MerchantOrderNo` 規則：英數，**同一商店不可重複**。infra-map 記著「同商店多專案 → 訂單前綴要不同」。這個站用前綴 **`HTK`**（html模板大王）。

### 2.2 回呼驗證（⛔ 安全重點）

收到 ReturnURL 的 POST 之後：

1. **先驗 `TradeSha`**，不符直接拒絕。不准「先解密再說」
2. 解密 `TradeInfo`，比對 `MerchantOrderNo` 是否為我們建立過的訂單
3. **比對金額**與訂單一致（防竄改）
4. 同一筆訂單重複回呼要 idempotent（已完成就不要重複處理）
5. 失敗/取消要有對應頁面，不要白頁

---

## 3. 訂單資料

```
reskin_orders
  id               TEXT PK           -- HTK + 時間 + 隨機
  site_id          TEXT NOT NULL
  product_id       TEXT NOT NULL
  product_name     TEXT NOT NULL
  amount           INTEGER NOT NULL
  currency         TEXT NOT NULL DEFAULT 'TWD'
  status           TEXT NOT NULL     -- 'pending' | 'paid' | 'failed' | 'cancelled'
  env              TEXT NOT NULL     -- 'test' | 'live'（哪個環境建的，別混）
  trade_no         TEXT              -- 藍新的交易序號
  paid_at          TEXT
  created_at       TEXT NOT NULL
  raw_result       TEXT              -- 解密後的回應（**金鑰不准存**）
```

控制台加一個「訂單」清單（唯讀）：時間、商品、金額、狀態、環境。

---

## 4. 付款成功之後

訂單 `paid` → 該商品對這個瀏覽器解鎖下載（沿用現有的 localStorage 會員/購買狀態，再加上伺服器端訂單為準）。

**不要**因為接了金流就把下載行為改掉 —— 下載仍然是導到上游的 `links.download`。

---

## 5. 硬性要求

1. **既有 1375 條測試全綠**
2. 加密與驗章要有單元測試（**用藍新文件的範例值**，不要用真金鑰）
3. **金鑰不出現在前端、HTML、log**
4. 缺 env → 示範模式；`ENV=live` → 購買列顯示警告色的「正式環境（會真的扣款）」
5. **真的用瀏覽器驗收並截圖**：示範模式的標示、`ENV=test` 時按下去會導到藍新測試頁（不用真的付款）
6. 不用 TDD、不用退化驗證、不用覆蓋率門檻

---

## 6. 完成的定義

1. 沒設 env → 示範模式，UI 有標示
2. 設了 test env → 按「立即購買」真的導到藍新測試付款頁，訂單進 DB 是 `pending`
3. 偽造的 `TradeSha` 回呼 → 被拒絕（寫一個測試證明）
4. `.env.example` 寫清楚四個鍵 + NotifyURL 在 localhost 收不到的限制
5. commit + push

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，不准任何 Claude / Co-Authored-By 署名。
