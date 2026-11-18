'use strict';

/**
 * 商品頁（SPEC-reskin §4.2）。
 *
 * ⛔ **購買區是版型的一部分，不是浮動層。** 上一輪用 `position: fixed` 做了一個
 * 浮動購買面板，使用者的評語是「你怎麼另外加開一個鬼浮動面板」——
 * 他是對的：那是貼在別人的頁面上，不是做進版面裡。
 * 這支把購買區放在 `.lm-product` 的**第二欄**，跟主圖同一個 grid；
 * 整份文件是我們產生的，所以它就是版面本身。CSS 裡沒有任何 `position: fixed`
 * 的購買面板（唯一的覆蓋層是按下載才開的 `<dialog>`，見 `parts.js`）。
 *
 * ⛔ 不准出現任何上游的字樣或選擇器。
 */

const { escapeHtml, formatCount, formatMoney, shopInitial } = require('./parts.js');

function renderGallery(data) {
  const images = data.gallery.length > 0 ? data.gallery : [];
  const main = images[0] ?? null;

  const strip =
    images.length > 1
      ? `<div class="lm-gallery-strip">${images
          .map(
            (src, index) => `
        <button type="button" data-lm-pick="${escapeHtml(src)}" aria-current="${index === 0}">
          <img src="${escapeHtml(src)}" alt="" loading="lazy">
        </button>`,
          )
          .join('')}</div>`
      : '';

  return `
  <div class="lm-gallery">
    <div class="lm-gallery-main">
      ${
        main === null
          ? ''
          : `<img src="${escapeHtml(main)}" alt="${escapeHtml(data.name ?? '')}" data-lm-main>`
      }
    </div>
    ${strip}
  </div>`;
}

/**
 * 規格選擇 ＝ 授權方案（規格 §4.2）。
 *
 * ⛔ **預設選中的是「價格區塊印的那一檔」，不是第一檔。**
 * 第一版預設選第一個方案，而價格區塊印的是 `headlinePrice()`（最便宜的
 * **付費**方案）—— 於是伺服器端印 `NT$199`，`shop.js` 一載入就照「選中的方案」
 * 把它改成 `免費`，使用者看到的是價格自己跳掉。
 * 兩邊要用同一個事實：選中的就是 headline 那一檔。
 */
function renderPlans({ currency, plans, headline }) {
  const selected = plans.find((plan) => plan.price === headline.price) ?? plans[0];

  return `
  <div class="lm-field">
    <h2>授權方案</h2>
    <div class="lm-field-body" data-lm-plan-group>
      ${plans
        .map(
          (plan) => `
        <button class="lm-plan" type="button" data-lm-plan="${escapeHtml(plan.id)}"
                data-lm-price="${escapeHtml(plan.price)}" aria-pressed="${plan === selected}">
          <b>${escapeHtml(plan.name)}</b>
          <small>${
            plan.price === 0 ? '不用錢' : escapeHtml(formatMoney(currency, plan.price))
          }${plan.note ? `・${escapeHtml(plan.note)}` : ''}</small>
        </button>`,
        )
        .join('')}
    </div>
  </div>`;
}

function renderStatsRow(data) {
  const views = formatCount(data.stats.views);
  const downloads = formatCount(data.stats.downloads);

  const cells = [
    views === null ? null : `<span><b>${escapeHtml(views)}</b> 瀏覽</span>`,
    downloads === null ? null : `<span><b>${escapeHtml(downloads)}</b> 已售出</span>`,
    data.id === null ? null : `<span>商品編號 ${escapeHtml(data.id)}</span>`,
  ].filter((cell) => cell !== null);

  return cells.length === 0 ? '' : `<div class="lm-stats-row">${cells.join('')}</div>`;
}

function renderPriceBlock({ currency, headline }) {
  const { price, originalPrice } = headline;
  const discount =
    originalPrice === null || originalPrice <= price
      ? ''
      : `<span class="lm-save">省 ${escapeHtml(
          Math.round(((originalPrice - price) / originalPrice) * 100),
        )}%</span>`;

  return `
  <div class="lm-price-block">
    <span class="lm-price" data-lm-price-out>${escapeHtml(formatMoney(currency, price))}</span>
    ${
      originalPrice === null
        ? ''
        : `<span class="lm-price-was">${escapeHtml(formatMoney(currency, originalPrice))}</span>`
    }
    ${discount}
  </div>`;
}

/**
 * 購買區。
 *
 * 「立即下載」的閘門在 `shop.js`：不是會員就開方案面板，而不是跳去原始連結
 * （規格 §4.3，這一塊就是 v6 那支 userscript 被版型吸收掉的功能）。
 * 下載連結抽不到就不畫那顆按鈕 —— 畫一顆按了沒事的按鈕比沒有更糟。
 */
function renderBuy(data, pricing) {
  const { currency, plans, headline } = pricing;

  return `
  <div class="lm-buy">
    <h1>${escapeHtml(data.name ?? '未命名商品')}</h1>
    ${renderStatsRow(data)}
    ${renderPriceBlock({ currency, headline })}
    ${renderPlans({ currency, plans, headline })}
    <div class="lm-field">
      <h2>數量</h2>
      <div class="lm-field-body">
        <div class="lm-qty">
          <button type="button" data-lm-qty="-1" aria-label="減少">&minus;</button>
          <output data-lm-qty-out>1</output>
          <button type="button" data-lm-qty="1" aria-label="增加">+</button>
        </div>
      </div>
    </div>
    <div class="lm-actions">
      <button class="lm-btn lm-btn-ghost" type="button" data-lm-add>加入購物車</button>
      <button class="lm-btn lm-btn-solid" type="button" data-lm-buy>立即購買</button>
    </div>
    <div class="lm-actions">
      ${
        data.links.download === null
          ? ''
          : `<a class="lm-btn lm-btn-flat" href="${escapeHtml(
              data.links.download,
            )}" data-lm-download>下載檔案</a>`
      }
      ${
        data.links.preview === null
          ? ''
          : `<a class="lm-btn lm-btn-flat" href="${escapeHtml(
              data.links.preview,
            )}" target="_blank" rel="noopener">線上預覽</a>`
      }
    </div>
    <p class="lm-note">購物車與會員狀態只存在這台瀏覽器（localStorage），沒有接金流。</p>
  </div>`;
}

function renderShop(data, { siteName }) {
  const downloads = formatCount(data.stats.downloads);

  return `
  <section class="lm-shop">
    <div class="lm-shop-avatar">${escapeHtml(shopInitial(siteName))}</div>
    <div class="lm-shop-main">
      <b>${escapeHtml(siteName)}</b>
      <p>official store・回覆率 98%・平均回覆時間 數分鐘內</p>
    </div>
    <div class="lm-shop-metrics">
      <div>評價<b>4.9 / 5.0</b></div>
      <div>商品<b>上架中</b></div>
      ${downloads === null ? '' : `<div>累積下載<b>${escapeHtml(downloads)}</b></div>`}
    </div>
    <div><button class="lm-btn lm-btn-flat" type="button" data-lm-follow>追蹤賣家</button></div>
  </section>`;
}

/** 規格表（規格 §4.2：標籤、新增日期、觀看數、下載數） */
function renderSpecs(data) {
  const rows = [
    data.tags.length === 0
      ? null
      : [
          '標籤',
          `<div class="lm-tags">${data.tags
            .map((tag) =>
              tag.url
                ? `<a class="lm-tag" href="${escapeHtml(tag.url)}">${escapeHtml(tag.name)}</a>`
                : `<span class="lm-tag">${escapeHtml(tag.name)}</span>`,
            )
            .join('')}</div>`,
        ],
    data.stats.addedAt === null ? null : ['上架日期', escapeHtml(data.stats.addedAt)],
    data.stats.views === null ? null : ['瀏覽次數', escapeHtml(formatCount(data.stats.views))],
    data.stats.downloads === null
      ? null
      : ['下載次數', escapeHtml(formatCount(data.stats.downloads))],
    data.id === null ? null : ['商品編號', escapeHtml(data.id)],
  ].filter((row) => row !== null);

  if (rows.length === 0) return '';

  return `
  <section class="lm-panel">
    <h2>商品規格</h2>
    <div class="lm-panel-body lm-scroll-x">
      <table class="lm-specs"><tbody>
        ${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </section>`;
}

function renderDescription(data) {
  if (data.description === null) return '';

  return `
  <section class="lm-panel">
    <h2>商品描述</h2>
    <div class="lm-panel-body"><p class="lm-desc">${escapeHtml(data.description)}</p></div>
  </section>`;
}

function renderCrumb(data, { home, siteName }) {
  return `
  <nav class="lm-crumb">
    <a href="${escapeHtml(home)}">${escapeHtml(siteName)}</a>
    <span>&rsaquo;</span>
    ${
      data.tags[0]?.url
        ? `<a href="${escapeHtml(data.tags[0].url)}">${escapeHtml(data.tags[0].name)}</a><span>&rsaquo;</span>`
        : ''
    }
    ${escapeHtml(data.name ?? '商品')}
  </nav>`;
}

/**
 * @param {object} data `extract.js` 的 product 資料
 * @param {{ currency, plans, headline }} pricing
 * @param {{ siteName: string, home: string }} context
 */
function renderProduct(data, pricing, context) {
  return `
  ${renderCrumb(data, context)}
  <section class="lm-product">
    ${renderGallery(data)}
    ${renderBuy(data, pricing)}
  </section>
  ${renderShop(data, context)}
  ${renderDescription(data)}
  ${renderSpecs(data)}
  <div style="height:24px"></div>`;
}

function productTitle(data, siteName) {
  return `${data.name ?? '商品'} | ${siteName} 模板商城`;
}

module.exports = { renderProduct, renderBuy, renderGallery, renderSpecs, productTitle };
