'use strict';

/**
 * 版型的共用零件：文件外殼、頂欄、搜尋列、分類列、頁尾、方案面板。
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

/** 店名：拿站名當店名（版型只認資料，不知道那是什麼站） */
function shopInitial(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : '#';
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
        <input id="lm-q" type="search" name="${escapeHtml(search.param)}" placeholder="搜尋商品">
        <button type="submit">搜尋</button>
      </div>
    </form>`;
}

/** 頂欄：品牌 + 搜尋 + 購物車（購物車的數字由 shop.js 從 localStorage 填） */
function renderHeader({ siteName, search, home }) {
  return `
  <header class="lm-top">
    <div class="lm-wrap">
      <div class="lm-top-thin">
        <span>賣家中心</span><span>下載我們的 App</span>
        <span data-lm-member-label>訪客</span>
      </div>
      <div class="lm-head">
        <a class="lm-brand" href="${escapeHtml(home)}">
          <b>${escapeHtml(siteName)}</b><i>模板商城</i>
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

function renderFooter({ siteName }) {
  return `
  <footer class="lm-foot"><div class="lm-wrap"><div class="lm-foot-cols">
    <div><b>客戶服務</b>幫助中心<br>付款方式<br>退款與退貨</div>
    <div><b>關於商城</b>關於我們<br>加入我們<br>隱私權政策</div>
    <div><b>付款方式</b>這是版型示範，沒有接金流。<br>購物車與會員狀態只存在這台瀏覽器裡。</div>
    <div><b>${escapeHtml(siteName)}</b>由 LocalMonkey 的重繪模式產生：上游只當資料來源，版面是我們自己的。</div>
  </div></div></footer>`;
}

/**
 * 方案面板（規格 §4.3 的下載閘門）。
 *
 * ⛔ 這是一個真的 `<dialog>`，**不是** `position: fixed` 的浮動層。
 * 上一輪就是拿浮動面板貼在上游頁面上，使用者的評語是「你怎麼另外加開一個
 * 鬼浮動面板」—— 重繪之後購買區本來就在版面裡（見 `product.js`），
 * 而這個面板只是「按下載但還不是會員」時才開的那一層。
 */
function renderPlanDialog({ currency, plans }) {
  return `
  <dialog class="lm-dialog" data-lm-plans>
    <div class="lm-dialog-head">
      <b>選擇授權方案</b>
      <button type="button" data-lm-close aria-label="關閉">&times;</button>
    </div>
    <div class="lm-dialog-body">
      <p>這份模板需要會員才能下載。選一個方案後就會解鎖下載，也會記住你的會員狀態。</p>
      <div class="lm-dialog-plans">
        ${plans
          .map(
            (plan) => `
          <button type="button" data-lm-join="${escapeHtml(plan.id)}">
            <span><b>${escapeHtml(plan.name)}</b><small>${escapeHtml(plan.note || '　')}</small></span>
            <em>${plan.price === 0 ? '免費' : escapeHtml(formatMoney(currency, plan.price))}</em>
          </button>`,
          )
          .join('')}
      </div>
      <p>※ 這是版型示範，不會真的收費，也沒有接任何金流。</p>
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
function renderDocument({ title, theme, siteName, search, categories, home, pricing, body, shopConfig }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(cssHref(theme))}">
</head>
<body>
${renderHeader({ siteName, search, home })}
${renderCategories(categories)}
<main class="lm-wrap">
${body}
</main>
${renderFooter({ siteName })}
${renderPlanDialog(pricing)}
<script type="application/json" data-lm-shop-config>${safeJson(shopConfig)}</script>
<script src="${escapeHtml(SHOP_SCRIPT)}" defer></script>
</body>
</html>`;
}

module.exports = {
  renderDocument,
  renderHeader,
  renderSearch,
  renderCategories,
  renderFooter,
  renderPlanDialog,
  formatCount,
  formatMoney,
  shopInitial,
  escapeHtml,
  cssHref,
  SHOP_SCRIPT,
};
