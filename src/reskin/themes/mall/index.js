'use strict';

/**
 * 商城版型的入口：**資料模型 → HTML**。
 *
 * ⛔ 這個目錄底下一個檔案都不准知道資料是從哪來的。檢查方式不是靠人記得 ——
 * `tests/unit/reskin-theme-purity.test.js` 會掃整個 `themes/` 目錄，
 * 看到上游的字樣或選擇器就紅。理由在 SPEC-reskin §0：使用者真正在做的是
 * 自己的模板商城，版型與商城機制是資產，抽取規則是可拋棄的那一層。
 * 兩者混在一起，整輪工作的價值就沒了。
 *
 * ⛔ **版型的身分是版面，不是顏色**（SPEC-reskin-v2 §1）：色票集中在
 * `css.js` 的 `TOKENS`，換色改一處就好，所以 `ID` 不叫顏色的名字。
 */

const {
  renderDocument,
  renderCheckoutDialog,
  renderNotice,
  paymentNote,
  BRAND,
} = require('./parts.js');
const { renderListing, renderFeed, listingTitle } = require('./listing.js');
const { renderProduct, productTitle } = require('./product.js');
const { headlinePrice } = require('../../pricing.js');
const { THEME_CSS } = require('./css.js');

const ID = 'mall';
const LABEL = '模板商城（深靛藍）';

/**
 * 給瀏覽器端 `shop.js` 的設定。**只放畫面要用的東西** ——
 * 這份 JSON 是公開的（它就在 HTML 裡），所以不要放任何內部資訊
 * （金流的網址與金鑰只活在伺服器端，見 `reskin/paygate.js`）。
 */
function shopConfigFor(data, pricing, { siteId, payments }) {
  return {
    siteId,
    currency: pricing.currency,
    payments: { live: payments.live, note: paymentNote(payments) },
    plans: pricing.plans.map((plan) => ({ id: plan.id, name: plan.name, price: plan.price })),
    item:
      data.kind === 'product'
        ? { id: data.id, name: data.name, image: data.gallery[0] ?? null }
        : null,
  };
}

function priceOf(pricing) {
  return { ...pricing, headline: headlinePrice(pricing.plans) };
}

/**
 * @param {object} data `extract.js` 的輸出（listing 或 product）
 * @param {{
 *   siteId: string,
 *   home: string,
 *   pricing: { currency: string, plans: Array<object> },
 *   payments: { live: boolean },
 * }} context
 * @returns {string} 一份完整的 HTML 文件（真文字，**不是** latin1 管線字串 ——
 *   編碼是 `reskin/service.js` 在邊界上做的事）
 */
function render(data, { siteId, home, pricing, payments }) {
  const priced = priceOf(pricing);

  const isProduct = data.kind === 'product';
  const body = isProduct
    ? renderProduct(data, priced, { home, payments })
    : renderListing(data, priced);

  return renderDocument({
    title: isProduct ? productTitle(data, BRAND) : listingTitle(data, BRAND),
    theme: ID,
    home,
    search: data.search ?? null,
    categories: data.categories ?? [],
    payments,
    body,
    // 結帳面板只有商品頁用得到；列表頁畫出來只是多一塊沒人叫得開的 DOM
    dialog: isProduct
      ? renderCheckoutDialog({
          currency: priced.currency,
          price: priced.headline.price,
          payments,
          itemName: data.name,
        })
      : '',
    shopConfig: shopConfigFor(data, priced, { siteId, payments }),
    // 無限載入的前端只有列表頁要載（SPEC-reskin-v2 §7）
    feed: !isProduct,
  });
}

/** 無限載入的下一頁（只回卡片，跟第一頁走同一支渲染函式） */
function renderNextPage(data, { pricing }) {
  return renderFeed(data, priceOf(pricing));
}

module.exports = {
  ID,
  LABEL,
  render,
  renderNextPage,
  /** 金流回跳的那一頁（用這個商城的招牌與樣式） */
  renderNotice: (input) => renderNotice({ ...input, theme: ID }),
  css: THEME_CSS,
};
