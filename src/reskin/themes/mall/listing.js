'use strict';

/**
 * 列表頁（SPEC-reskin §4.1）：卡片網格 + 無限載入（SPEC-reskin-v2 §7）。
 *
 * ⛔ 不准出現任何上游的字樣或選擇器。這支只認資料模型的
 * `items / page / totalPages / nextPath / categories`。
 */

const { escapeHtml, formatCount, formatMoney, heading } = require('./parts.js');

/** 卡片上那排小標籤最多兩個 —— 第三個在 1:1 的卡片寬度裡一定被切掉 */
const MAX_CARD_TAGS = 2;

/**
 * 角落那兩個標。
 *
 * ⛔ 免費標的字是**方案自己的名字**，不是寫死的「免費版」：方案名在
 * per-site 的價格設定裡（`pricing.js`），使用者改了名字卻看到卡片上還是舊字
 * 就是兩個真相來源。沒有免費方案就不畫那個標（預設就沒有，見 `pricing.js`）。
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
 * 一張卡（規格 §4.1）：縮圖 1:1、品名兩行截斷、價格、**價格下面一行「已售出 N 份」**
 * （SPEC-reskin-v2 §4）、標籤膠囊。
 *
 * 「已售出」用的是資料模型的 `stats.downloads` —— 這是一個模板商城，
 * 一次下載就是一次成交。沒有那個數字的時候那一行不畫
 * （**不要**印「已售出 0 份」，那是假資料）。
 */
function renderCard(item, { currency, price, originalPrice, freeLabel }) {
  const sold = formatCount(item.stats?.downloads);
  const href = item.url ?? '#';

  return `
  <a class="lm-card" href="${escapeHtml(href)}">
    ${renderThumb(item, { freeLabel })}
    <div class="lm-card-body">
      ${heading(3, 'lm-card-name', item.name ?? '未命名')}
      ${renderTags(item.tags)}
      <div class="lm-card-foot">
        <span class="lm-price"><small>${escapeHtml(currency)}</small>${escapeHtml(
          Number(price).toLocaleString('en-US'),
        )}${
          originalPrice === null
            ? ''
            : `<span class="lm-price-was">${escapeHtml(formatMoney(currency, originalPrice))}</span>`
        }</span>
        ${sold === null ? '' : `<span class="lm-sold">已售出 ${escapeHtml(sold)} 份</span>`}
      </div>
    </div>
  </a>`;
}

/** 這一批卡片（第一頁與之後每一頁都走這支，所以兩邊長得一模一樣） */
function renderCards(items, card) {
  return items.map((item) => renderCard(item, card)).join('');
}

/** 價格設定 → 一張卡要知道的那幾個值 */
function cardStyleOf({ currency, plans, headline }) {
  return {
    currency,
    ...headline,
    freeLabel: plans.find((plan) => plan.price === 0)?.name ?? null,
  };
}

function pageInfo({ page, totalPages }) {
  if (page === null) return '';
  return totalPages === null ? `第 ${page} 頁` : `第 ${page} / ${totalPages} 頁`;
}

/**
 * 無限載入的尾巴（SPEC-reskin-v2 §7：往下滾自動載入，不要頁碼）。
 *
 * ⛔ **三件事都要在這裡準備好，不能交給前端自己想辦法**：
 *
 * 1. `data-lm-next` ＝ 下一頁的路徑。**是抽取層算的**（`extract.js` 的
 *    `nextPath`），因為只有它看得到上游的分頁長什麼樣 —— 版型層不知道
 *    上游是誰，不可能自己組網址。
 * 2. 狀態列（`role="status"`）**由前端填字**。伺服器端不先寫「往下滑會自動
 *    載入」—— JS 沒跑起來的時候那句話就是在騙人。
 * 3. `<noscript>` 的真連結：那是 JS 沒跑起來時唯一的退路。
 */
function renderFeedTail(data) {
  const info = pageInfo(data);
  const hasNext = typeof data.nextPath === 'string' && data.nextPath.length > 0;

  return `
  <div class="lm-feed" data-lm-feed ${hasNext ? `data-lm-next="${escapeHtml(data.nextPath)}"` : ''}>
    <p class="lm-feed-status" data-lm-feed-status role="status" aria-live="polite">${
      hasNext ? '' : '已經到底了'
    }</p>
    <button class="lm-feed-retry" type="button" data-lm-feed-retry hidden>重試</button>
    ${
      hasNext
        ? `<noscript><a class="lm-feed-link" href="${escapeHtml(data.nextPath)}">看下一頁</a></noscript>`
        : ''
    }
    ${/*
      ⛔ 這一格**永遠畫出來**，就算現在不知道是第幾頁（首頁沒有頁碼列）。
      前端載入下一頁之後就知道了，而它只會填現成的格子 ——
      版型層以外的地方不准長出新的 DOM 結構（那是第二份 markup）。
    */ ''}
    <span class="lm-feed-page" data-lm-feed-page>${escapeHtml(info)}</span>
  </div>`;
}

/**
 * @param {object} data `extract.js` 的 listing 資料
 * @param {{ currency: string, plans: Array<object>, headline: object }} pricing
 */
function renderListing(data, pricing) {
  const card = cardStyleOf(pricing);

  const grid =
    data.items.length > 0
      ? `<div class="lm-grid" data-lm-grid>${renderCards(data.items, card)}</div>`
      : '<div class="lm-empty">這一頁沒有商品。</div>';

  return `
  <section>
    <div class="lm-section-head">
      ${heading(1, 'lm-section-title', '精選模板')}
      <p>${escapeHtml(data.items.length)} 件${
        data.totalPages === null ? '' : `・共 ${escapeHtml(data.totalPages)} 頁`
      }</p>
    </div>
    ${grid}
    ${renderFeedTail(data)}
  </section>`;
}

/**
 * 無限載入的下一頁（`/__lm/reskin/listing` 回的 `html`）。
 *
 * ⛔ **只回卡片，而且跟第一頁走同一支 `renderCards`。** 端點回 JSON 讓前端
 * 自己畫的話，卡片的 markup 就有兩份（伺服器一份、瀏覽器一份）——
 * 這個專案已經踩過「同一個值兩邊各算一次 → 畫面自己跳」那個坑（地雷 62）。
 */
function renderFeed(data, pricing) {
  return renderCards(data.items, cardStyleOf(pricing));
}

/** 頁面標題（瀏覽器分頁上那行） */
function listingTitle(data, brand) {
  const page = data.page === null || data.page === 1 ? '' : ` - 第 ${data.page} 頁`;
  return `${brand}${page}`;
}

module.exports = {
  renderListing,
  renderCard,
  renderCards,
  renderFeed,
  renderFeedTail,
  cardStyleOf,
  pageInfo,
  listingTitle,
};
