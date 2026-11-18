'use strict';

/**
 * 版型的共用零件：文件外殼、頂欄、搜尋列、分類列、頁尾、結帳面板。
 *
 * ⛔ 跟整個 `themes/` 一樣：**不准出現任何上游的字樣或選擇器。**
 * 這裡看得到的名字全是我們資料模型的鍵（`items`、`categories`、`search`）。
 *
 * 所有外部資源都走**根絕對路徑**（`/__lm/reskin/…`）。刻意不輸出
 * `<base href>` —— 代理的頁面已經因為上游的 `<base>` 吃過一次「整頁沒樣式」
 * （CLAUDE.md 地雷 28），我們自己產生的文件沒有理由再引入那個風險。
 */

const { escapeHtml } = require('../../../views/pages.js');
// ⛔ `JSON.stringify` **不會**轉義 `</script>`，所以把 JSON 內嵌進 HTML 之前
// 一定要再補一層（`<` → `<`、U+2028/9）。這個專案已經有一支做這件事的
// 函式，不要在這裡寫第二份 —— 轉義規則有兩份就會有一份忘了更新。
const { safeJson } = require('../../../lib/gm-shim.js');

const SHOP_SCRIPT = '/__lm/reskin/shop.js';
const FEED_SCRIPT = '/__lm/reskin/feed.js';

/**
 * 店名與副標。
 *
 * ⛔ **刻意不是 `site.name`。** 那個欄位記的是「被代理的那個站叫什麼」——
 * 一個上游的身分（而且使用者的 `text-replace` 規則會連它一起改）。
 * 上一版就是把它印在品牌位置，於是商城的招牌變成了資料來源的網域名。
 *
 * 招牌是**我們這個商城自己的東西**（SPEC-reskin §0：版型與商城機制是資產，
 * 抽取規則才是可拋棄的那一層），所以它跟「分類」「推薦商品」一樣是版型的文案。
 * 要做成 per-site 設定的時候再加一個欄位，不要退回去讀 `site.name`。
 */
const BRAND = 'html模板大王';
const TAGLINE = '精選網頁模板';

function cssHref(theme) {
  return `/__lm/reskin/${theme}.css`;
}

/** 千分位。`null` 的欄位一律不顯示（規格 §2：缺欄位不是錯誤） */
function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : null;
}

function formatMoney(currency, amount) {
  return `${currency}${Number(amount).toLocaleString('en-US')}`;
}

/** 店家頭像上那個字 */
function shopInitial(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : '#';
}

/**
 * ⛔ **品名與區塊標題刻意不用 `<h1>`，而是 `role="heading"`。**
 *
 * 實測現場（2026-11-19）：商品頁的品名顯示「這頁經過 LocalMonkey」而不是
 * 模板名字，而麵包屑是對的 —— 因為資料是對的。真正動手腳的是使用者自己
 * 那支還開著的注入測試腳本，它在瀏覽器裡做
 * `document.querySelector("h1").replaceChildren(…)` 並且掛了 MutationObserver。
 * 伺服器端怎麼抽都救不了（注入發生在重繪**之後**，見 proxy/respond.js 的順序）。
 *
 * 「頁面上第一個 h1 就是標題」是油猴腳本最常見的假設，而重繪過的文件是
 * **我們的**版面、不是它們當初寫腳本時看到的那一頁。不給它那個把手最省事，
 * 而 `role="heading" aria-level` 對輔助科技來說是同一件事（標題層級還在）。
 */
function heading(level, className, text) {
  return `<div class="${className}" role="heading" aria-level="${level}">${escapeHtml(text)}</div>`;
}

/**
 * 搜尋列。
 *
 * 規格 §4.1：「可用就接上游搜尋，不行就先擺著不作用並標示」。
 * 抽取設定沒給 `search` 時畫一個 disabled 的框 + 一句說明 ——
 * **不要**畫一個看起來能用但按了沒反應的框，那比沒有更難懂。
 */
function renderSearch(search) {
  if (!search) {
    return `
      <div class="lm-search">
        <div class="lm-search-box" data-inert="1">
          <label class="lm-sr" for="lm-q">搜尋</label>
          <input id="lm-q" type="search" placeholder="搜尋尚未接上資料來源" disabled>
          <button type="button" disabled aria-disabled="true">搜尋</button>
        </div>
        <p class="lm-search-note">這個資料來源還沒設定搜尋端點，所以搜尋框暫時不作用。</p>
      </div>`;
  }

  return `
    <form class="lm-search" method="get" action="${escapeHtml(search.action)}" role="search">
      <div class="lm-search-box">
        <label class="lm-sr" for="lm-q">搜尋</label>
        <input id="lm-q" type="search" name="${escapeHtml(search.param)}" placeholder="搜尋模板">
        <button type="submit">搜尋</button>
      </div>
    </form>`;
}

/**
 * 頂欄：品牌 + 搜尋 + 購物車（購物車的數字由 shop.js 從 localStorage 填）。
 *
 * ⛔ 上一版頂上還有一排「賣家中心 / 下載我們的 App / 訪客」——
 * 那是在模仿別人的電商。這個站沒有賣家、沒有 App，留著只會讓人以為點得進去
 * （SPEC-reskin-v2 §2）。保留的是搜尋列與購物車，因為那兩個真的有東西在後面。
 */
function renderHeader({ search, home }) {
  return `
  <header class="lm-top">
    <div class="lm-wrap">
      <div class="lm-head">
        <a class="lm-brand" href="${escapeHtml(home)}">
          <b>${escapeHtml(BRAND)}</b><i>${escapeHtml(TAGLINE)}</i>
        </a>
        ${renderSearch(search)}
        <button class="lm-cart" type="button" data-lm-cart-open aria-label="購物車">
          <span>購物車</span>
          <span class="lm-cart-count" data-lm-cart-count>0</span>
        </button>
      </div>
    </div>
  </header>`;
}

/** 分類列 ＝ 標籤（規格 §4.1）。一個都沒抽到就整列不畫。 */
function renderCategories(categories) {
  const pills = (categories ?? []).filter((item) => item.name && item.url);
  if (pills.length === 0) return '';

  return `
  <nav class="lm-cats"><div class="lm-wrap"><div class="lm-cats-inner">
    <h2>分類</h2>
    ${pills
      .map((item) => `<a class="lm-pill" href="${escapeHtml(item.url)}">${escapeHtml(item.name)}</a>`)
      .join('')}
  </div></div></nav>`;
}

/** 金流那一句話只有一個真相來源：伺服器端的 `payments.live` */
function paymentNote(payments) {
  return payments.live
    ? '結帳走 PayGate 的測試環境，所以是真的刷卡流程、但扣的是測試金流。'
    : '這個站還沒接金流（示範模式）：購物車與訂單只存在這台瀏覽器裡。';
}

function renderFooter({ payments }) {
  return `
  <footer class="lm-foot"><div class="lm-wrap"><div class="lm-foot-cols">
    <div><b>客戶服務</b>幫助中心<br>付款方式<br>退款與退貨</div>
    <div><b>關於商城</b>關於我們<br>加入我們<br>隱私權政策</div>
    <div><b>付款方式</b>${escapeHtml(paymentNote(payments))}</div>
    <div><b>${escapeHtml(BRAND)}</b>由 LocalMonkey 的重繪模式產生：上游只當資料來源，版面是我們自己的。</div>
  </div></div></footer>`;
}

/**
 * 結帳面板。
 *
 * ⛔ 這是一個真的 `<dialog>`，**不是** `position: fixed` 的浮動層。
 * 上一輪就是拿浮動面板貼在上游頁面上，使用者的評語是「你怎麼另外加開一個
 * 鬼浮動面板」—— 重繪之後購買區本來就在版面裡（見 `product.js`），
 * 這個面板只是按下「立即購買」之後那一步。
 *
 * ⛔ **沒接金流的時候不准畫 email 欄位。** 問了卻什麼都不做比不問更糟
 * （同搜尋框那條：不要畫看起來能用的東西）。兩種模式共用一個面板，
 * 差別只有「收不收 email」與那段說明。
 */
function renderCheckoutDialog({ currency, price, payments, itemName }) {
  const amount = price === 0 ? '免費' : formatMoney(currency, price);

  return `
  <dialog class="lm-dialog" data-lm-checkout>
    <div class="lm-dialog-head">
      <b>${payments.live ? '結帳' : '確認訂單（示範）'}</b>
      <button type="button" data-lm-close aria-label="關閉">&times;</button>
    </div>
    <div class="lm-dialog-body">
      <div class="lm-dialog-line">
        <span>${escapeHtml(itemName ?? '這份模板')}</span>
        <em>${escapeHtml(amount)}</em>
      </div>
      <p>${escapeHtml(paymentNote(payments))}</p>
      ${
        payments.live
          ? `
      <label for="lm-email">收據要寄到哪個 email
        <input id="lm-email" type="email" inputmode="email" autocomplete="email"
               placeholder="you@example.com" data-lm-email required>
      </label>`
          : ''
      }
      <p class="lm-dialog-error" data-lm-checkout-error hidden></p>
      <div class="lm-dialog-foot">
        <button class="lm-btn lm-btn-flat" type="button" data-lm-close>取消</button>
        <button class="lm-btn lm-btn-solid" type="button" data-lm-checkout-go>
          ${payments.live ? '前往付款' : '確認'}
        </button>
      </div>
    </div>
  </dialog>`;
}

/**
 * 整份文件。
 *
 * `lang="zh-Hant"`：版型的文案是繁體中文。翻譯層之後還會跑在這份 HTML 上
 * （規格 §5 的執行順序），而它只有真的翻了才會改 `<html lang>`，所以這裡
 * 先宣告正確的語言不會互相打架。
 *
 * `charset=utf-8` 是必要的：我們插入的是中文，而代理的 HTML 管線走 latin1
 * （`service.js` 負責在邊界上編碼）。沒有這一行瀏覽器會自己猜。
 */
function renderDocument({
  title,
  theme,
  home,
  search,
  categories,
  payments,
  body,
  dialog,
  shopConfig,
  feed,
}) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(cssHref(theme))}">
</head>
<body>
${renderHeader({ search, home })}
${renderCategories(categories)}
<main class="lm-wrap">
${body}
</main>
${renderFooter({ payments })}
${dialog ?? ''}
<script type="application/json" data-lm-shop-config>${safeJson(shopConfig)}</script>
<script src="${escapeHtml(SHOP_SCRIPT)}" defer></script>
${feed ? `<script src="${escapeHtml(FEED_SCRIPT)}" defer></script>` : ''}
</body>
</html>`;
}

/**
 * 一頁「只有一段話」的通知頁（金流回跳用，SPEC-reskin-v2 §8）。
 *
 * 為什麼在版型層：它用的是這個商城的招牌與樣式表，所以它屬於**我們的版面**，
 * 不是一頁通用的錯誤頁。資料模型完全沒有參與 —— 所以它收的是現成的文字，
 * 這樣版型層仍然不知道任何上游的事。
 */
function renderNotice({ title, lines, home, theme = 'mall' }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}｜${escapeHtml(BRAND)}</title>
<link rel="stylesheet" href="${escapeHtml(cssHref(theme))}">
</head>
<body>
${renderHeader({ search: null, home: home ?? '/' })}
<main class="lm-wrap">
  <section class="lm-panel">
    <h2>${escapeHtml(title)}</h2>
    <div class="lm-panel-body">
      ${(lines ?? []).map((line) => `<p class="lm-note">${escapeHtml(line)}</p>`).join('')}
      ${
        home === null || home === undefined
          ? ''
          : `<p style="margin-top:16px"><a class="lm-btn lm-btn-solid" href="${escapeHtml(home)}">回商城</a></p>`
      }
    </div>
  </section>
</main>
</body>
</html>`;
}

module.exports = {
  renderDocument,
  renderNotice,
  renderHeader,
  renderSearch,
  renderCategories,
  renderFooter,
  renderCheckoutDialog,
  paymentNote,
  heading,
  formatCount,
  formatMoney,
  shopInitial,
  escapeHtml,
  cssHref,
  BRAND,
  TAGLINE,
  SHOP_SCRIPT,
  FEED_SCRIPT,
};
