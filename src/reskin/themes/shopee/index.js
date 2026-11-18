'use strict';

/**
 * 蝦皮風格版型的入口：**資料模型 → HTML**。
 *
 * ⛔ 這個目錄底下一個檔案都不准知道資料是從哪來的。檢查方式不是靠人記得 ——
 * `tests/unit/reskin-theme-purity.test.js` 會掃整個 `themes/` 目錄，
 * 看到上游的字樣或選擇器就紅。理由在 SPEC-reskin §0：使用者真正在做的是
 * 自己的模板商城，版型與商城機制是資產，抽取規則是可拋棄的那一層。
 * 兩者混在一起，整輪工作的價值就沒了。
 */

const { renderDocument } = require('./parts.js');
const { renderListing, listingTitle } = require('./listing.js');
const { renderProduct, productTitle } = require('./product.js');
const { headlinePrice } = require('../../pricing.js');
const { THEME_CSS } = require('./css.js');

const ID = 'shopee';
const LABEL = '蝦皮風格商城';

/**
 * 給瀏覽器端 `shop.js` 的設定。**只放畫面要用的東西** ——
 * 這份 JSON 是公開的（它就在 HTML 裡），所以不要放任何內部資訊。
 */
function shopConfigFor(data, pricing) {
  return {
    currency: pricing.currency,
    plans: pricing.plans.map((plan) => ({ id: plan.id, name: plan.name, price: plan.price })),
    item:
      data.kind === 'product'
        ? { id: data.id, name: data.name, image: data.gallery[0] ?? null }
        : null,
  };
}

/**
 * @param {object} data `extract.js` 的輸出（listing 或 product）
 * @param {{
 *   siteName: string,
 *   home: string,
 *   pricing: { currency: string, plans: Array<object> },
 * }} context
 * @returns {string} 一份完整的 HTML 文件（真文字，**不是** latin1 管線字串 ——
 *   編碼是 `reskin/service.js` 在邊界上做的事）
 */
function render(data, { siteName, home, pricing }) {
  const priced = { ...pricing, headline: headlinePrice(pricing.plans) };

  const isProduct = data.kind === 'product';
  const body = isProduct
    ? renderProduct(data, priced, { siteName, home })
    : renderListing(data, priced);

  return renderDocument({
    title: isProduct ? productTitle(data, siteName) : listingTitle(data, siteName),
    theme: ID,
    siteName,
    home,
    search: data.search ?? null,
    categories: data.categories ?? [],
    pricing: priced,
    body,
    shopConfig: shopConfigFor(data, priced),
  });
}

module.exports = { ID, LABEL, render, css: THEME_CSS };
