'use strict';

/**
 * templatemo.com 的抽取設定。
 *
 * ⛔ **這是資料，不是引擎的一部分 —— 而且它是整輪工作裡唯一「本來就會被丟掉」
 * 的東西**（SPEC-reskin §0）。使用者真正在做的是自己的模板商城原型，
 * 這個站只是「真實感的假資料」。換資料來源的時候，整個檔案換掉、
 * `src/reskin/themes/` 一個字都不用動。
 *
 * （同一個分寸見 `rules/presets/templatemo-com.js`。）
 *
 * ## 選擇器的語法
 *
 * 跟文字規則的 `scope` 是**同一套**（`rules/scope.js`）：
 * `tag` / `.class` / `#id` / `*`，加上後代（空白）與子（`>`）組合子、逗號分隔。
 * `[href^=…]`、`:has()`、`+` 一律編不過（拒絕比忽略安全）。
 *
 * ## 為什麼有些欄位長得這麼怪
 *
 * - `views` / `downloads` 用 `extract`：上游那兩個數字是**裸的文字節點**
 *   （`<strong>Views:</strong> 11,249`），沒有任何元素包著它們 ——
 *   選擇器再強都抓不到，只有正則抓得到。而同一個 `#tm-dl-box p` 會配到
 *   三個段落，所以靠「第一個**有值的**候選」挑出對的那一個（`extract.js`）。
 * - `tags` 用 `when`：標籤連結跟「這個模板 100% 免費下載」的連結在
 *   **同一個容器、同一個選擇器**底下，只有 `href` 的前綴分得出來。
 * - `id` 從網址取而不是從 HTML：商品編號在路徑裡，而列表頁的每一張卡
 *   **也只有網址可用** —— 所以同一條 `id` 正則在兩種頁面上都成立。
 */

/** `/`、`/page/2`：列表頁 */
const LISTING = Object.freeze({
  kind: 'listing',
  note: '列表頁（首頁與分頁）',
  match: '^/(page/\\d+/?)?$',
  item: '.thumbnail_270',
  // `/tm-634-lantern-river` → `634`
  id: '/tm-(\\d+)-',
  fields: {
    name: { sel: 'h2 a', attr: 'text' },
    url: { sel: 'h2 a', attr: 'href', as: 'url' },
    image: { sel: 'img', attr: 'src', as: 'url' },
    desc: { sel: '.tn_desc', attr: 'text' },
  },
  page: {
    page: { sel: '.paging .current', attr: 'text', as: 'number' },
    totalPages: { sel: '.paging_info', attr: 'text', extract: 'of\\s+(\\d+)', as: 'number' },
    // ⛔ `when` 是必要的，不是保險：上游把**同一個 class** 用在頁碼列與標籤列
    // 兩個地方，所以 `.paging a` 會把六個標籤連結一起收進分頁列
    // （實測症狀：分頁變成「1 2345678下一步 模板標籤 單頁 攝影…」）。
    // 分得出來的只有 href，而 `[href*=…]` 是選擇器文法明確拒絕的。
    pages: {
      sel: '.paging a',
      as: 'link',
      many: true,
      when: { attr: 'href', match: 'page/\\d+' },
    },
    categories: { sel: 'a', as: 'link', many: true, when: { attr: 'href', match: '^/tag/' } },
  },
});

/** `/tm-628-lumen-eighty`：商品頁 */
const PRODUCT = Object.freeze({
  kind: 'product',
  note: '商品頁',
  match: '^/tm-\\d+',
  id: '^/tm-(\\d+)',
  fields: {
    name: { sel: 'h1.title', attr: 'text' },
    image: { sel: '.tm-preview-screenshot img', attr: 'src', as: 'url' },
    description: { sel: 'p.description', attr: 'text' },
    tags: {
      sel: '#tm-dl-box p a',
      as: 'link',
      many: true,
      when: { attr: 'href', match: '^/tag/' },
    },
    addedAt: { sel: '#tm-dl-box p span', attr: 'text' },
    views: { sel: '#tm-dl-box p', attr: 'text', extract: 'Views:\\s*([\\d,]+)', as: 'number' },
    downloads: {
      sel: '#tm-dl-box p',
      attr: 'text',
      extract: 'Downloads:\\s*([\\d,]+)',
      as: 'number',
    },
    preview: { sel: '#tm-view', attr: 'href', as: 'url' },
    download: { sel: '#tm-download', attr: 'href', as: 'url' },
  },
});

/** `/tag/portfolio`：標籤頁的卡片容器跟列表頁不一樣（詳情頁底下那排也是這個） */
const TAG_LISTING = Object.freeze({
  kind: 'listing',
  note: '標籤頁',
  match: '^/tag/',
  item: '.tm_silver_360, .thumbnail_270',
  id: '/tm-(\\d+)-',
  fields: {
    name: { sel: 'h2 a', attr: 'text' },
    url: { sel: 'h2 a', attr: 'href', as: 'url' },
    image: { sel: 'img', attr: 'src', as: 'url' },
    desc: { sel: '.tn_desc', attr: 'text' },
  },
  page: {
    page: { sel: '.paging .current', attr: 'text', as: 'number' },
    totalPages: { sel: '.paging_info', attr: 'text', extract: 'of\\s+(\\d+)', as: 'number' },
    // ⛔ `when` 是必要的，不是保險：上游把**同一個 class** 用在頁碼列與標籤列
    // 兩個地方，所以 `.paging a` 會把六個標籤連結一起收進分頁列
    // （實測症狀：分頁變成「1 2345678下一步 模板標籤 單頁 攝影…」）。
    // 分得出來的只有 href，而 `[href*=…]` 是選擇器文法明確拒絕的。
    pages: {
      sel: '.paging a',
      as: 'link',
      many: true,
      when: { attr: 'href', match: 'page/\\d+' },
    },
    categories: { sel: 'a', as: 'link', many: true, when: { attr: 'href', match: '^/tag/' } },
  },
});

/**
 * ⛔ **順序就是比對順序**（第一個命中的勝出）。`^/tag/` 要排在 `^/tm-\d+`
 * 之前沒關係（兩者不重疊），但列表頁的 `^/(page/\d+/?)?$` 一定要是錨定的 ——
 * 不然它會吃掉所有路徑，連 `/about` 都會被重繪成一頁空的卡片網格。
 */
const TEMPLATEMO_RESKIN = Object.freeze([LISTING, TAG_LISTING, PRODUCT]);

module.exports = { TEMPLATEMO_RESKIN, LISTING, TAG_LISTING, PRODUCT };
