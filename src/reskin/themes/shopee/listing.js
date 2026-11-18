'use strict';

/**
 * 列表頁（SPEC-reskin §4.1）：卡片網格。
 *
 * ⛔ 不准出現任何上游的字樣或選擇器。這支只認資料模型的
 * `items / page / totalPages / pages / categories`。
 */

const { escapeHtml, formatCount, formatMoney } = require('./parts.js');

/** 卡片上那排小標籤最多兩個 —— 第三個在 1:1 的卡片寬度裡一定被切掉 */
const MAX_CARD_TAGS = 2;

/**
 * 角落那兩個標。
 *
 * ⛔ 免費標的字是**方案自己的名字**，不是寫死的「免費版」：方案名在
 * per-site 的價格設定裡（`pricing.js`），使用者改了名字卻看到卡片上還是舊字
 * 就是兩個真相來源。沒有免費方案就不畫那個標。
 */
function renderThumb(item, { freeLabel }) {
  const inner = item.image
    ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name ?? '')}" loading="lazy">`
    : '';

  return `
    <div class="lm-thumb">
      ${inner}
      ${freeLabel === null ? '' : `<span class="lm-badge-free">${escapeHtml(freeLabel)}</span>`}
      <span class="lm-badge">可商用</span>
    </div>`;
}

function renderTags(tags) {
  const picked = (tags ?? [])
    .map((tag) => (typeof tag === 'string' ? { name: tag } : tag))
    .filter((tag) => tag && tag.name)
    .slice(0, MAX_CARD_TAGS);

  if (picked.length === 0) return '';

  return `<div class="lm-card-tags">${picked
    .map((tag) => `<span class="lm-tag-mini">${escapeHtml(tag.name)}</span>`)
    .join('')}</div>`;
}

/**
 * 一張卡（規格 §4.1）：縮圖 1:1、品名兩行截斷、價格、已售出（＝下載數）、標籤膠囊。
 *
 * 「已售出」用下載數是刻意的 —— 這是一個模板商城，下載就是成交。
 * 沒有下載數的時候那一格空著（**不要**印「已售出 0」，那是假資料）。
 */
function renderCard(item, { currency, price, originalPrice, freeLabel }) {
  const sold = formatCount(item.stats?.downloads);
  const href = item.url ?? '#';

  return `
  <a class="lm-card" href="${escapeHtml(href)}">
    ${renderThumb(item, { freeLabel })}
    <div class="lm-card-body">
      <h3 class="lm-card-name">${escapeHtml(item.name ?? '未命名')}</h3>
      ${renderTags(item.tags)}
      <div class="lm-card-foot">
        <span class="lm-price"><small>${escapeHtml(currency)}</small>${escapeHtml(
          Number(price).toLocaleString('en-US'),
        )}${
          originalPrice === null
            ? ''
            : `<span class="lm-price-was">${escapeHtml(formatMoney(currency, originalPrice))}</span>`
        }</span>
        ${sold === null ? '' : `<span class="lm-sold">已售出 ${escapeHtml(sold)}</span>`}
      </div>
    </div>
  </a>`;
}

/**
 * 分頁（規格 §4.1：沿用上游的頁碼）。
 *
 * 頁碼連結是抽出來的（版型層不知道上游的網址長什麼樣，所以不可能自己組），
 * 抽不到就只印「第 N / M 頁」—— 有頁碼資訊但不能跳，總比假裝沒有分頁好。
 */
function renderPager({ page, totalPages, pages }) {
  const links = (pages ?? []).filter((link) => link.name && link.url);
  const info =
    page !== null && totalPages !== null
      ? `<span class="lm-page-info">第 ${escapeHtml(page)} / ${escapeHtml(totalPages)} 頁</span>`
      : '';

  if (links.length === 0) return info === '' ? '' : `<nav class="lm-pager">${info}</nav>`;

  return `
  <nav class="lm-pager">
    ${
      page === null
        ? ''
        : `<span class="lm-page-current">${escapeHtml(page)}</span>`
    }
    ${links
      .map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.name)}</a>`)
      .join('')}
    ${info}
  </nav>`;
}

/**
 * @param {object} data `extract.js` 的 listing 資料
 * @param {{ currency: string, plans: Array<object>, headline: object }} pricing
 */
function renderListing(data, pricing) {
  const { currency, plans, headline } = pricing;
  const card = {
    currency,
    ...headline,
    freeLabel: plans.find((plan) => plan.price === 0)?.name ?? null,
  };

  const grid =
    data.items.length > 0
      ? `<div class="lm-grid">${data.items.map((item) => renderCard(item, card)).join('')}</div>`
      : '<div class="lm-empty">這一頁沒有商品。</div>';

  return `
  <section>
    <div class="lm-section-head">
      <h1>推薦商品</h1>
      <p>${escapeHtml(data.items.length)} 件${
        data.totalPages === null ? '' : `・共 ${escapeHtml(data.totalPages)} 頁`
      }</p>
    </div>
    ${grid}
    ${renderPager(data)}
  </section>`;
}

/** 頁面標題（瀏覽器分頁上那行） */
function listingTitle(data, siteName) {
  const page = data.page === null ? '' : ` - 第 ${data.page} 頁`;
  return `${siteName} 模板商城${page}`;
}

module.exports = { renderListing, renderCard, renderPager, listingTitle };
