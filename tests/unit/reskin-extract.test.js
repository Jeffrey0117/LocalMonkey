'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDocument } = require('../../src/reskin/dom.js');
const { compileSelector, queryAll, textOf, valueOf } = require('../../src/reskin/query.js');
const { compileConfig, findEntry } = require('../../src/reskin/config.js');
const { extractData } = require('../../src/reskin/extract.js');
const { compilePricing, headlinePrice, DEFAULT_PLANS } = require('../../src/reskin/pricing.js');
const { toProxied } = require('../../src/reskin/url.js');

/**
 * 重繪的抽取層（SPEC-reskin §3）。
 *
 * 這一支釘的大多是**靜默**的錯 —— 抽錯的症狀是「某個欄位一直是空的」或
 * 「清單少了幾項」，而選擇器怎麼看都是對的，所以肉眼複查完全無效。
 */

const SITE = { siteId: 'shop', targetOrigin: 'https://upstream.test' };

function sel(source) {
  const compiled = compileSelector(source);
  assert.ok(compiled.ok, compiled.error);
  return compiled.value;
}

/* ------------------------------ dom / query ------------------------------ */

/**
 * ⛔ 地雷 59：文字節點與子元素**混在同一個 children 裡**，順序不能丟。
 *
 * 第一版把直接文字累加在 node.text、子元素另外放，於是 textOf() 吐出
 * 「所有直接文字」再接「所有子元素的文字」。實測中招的就是下面這個形狀：
 * `11,249 1,354Views:Downloads:` —— 於是 `Views:\s*([\d,]+)` 永遠抽不到。
 */
test('⛔ textOf 照文件順序，不是「自己的文字再接子元素」', () => {
  const root = parseDocument(
    '<p><strong>Views:</strong> 11,249 &nbsp; <strong>Downloads:</strong> 1,354</p>',
  );
  const [p] = queryAll(root, sel('p'));

  assert.equal(textOf(p).replace(/\s+/g, ' ').trim(), 'Views: 11,249 &nbsp; Downloads: 1,354');
  // 正規化之後（entity 還原 + 壓白空白）才是欄位拿到的值
  assert.match(valueOf(p, 'text'), /Views: 11,249/);
  assert.match(valueOf(p, 'text'), /Downloads: 1,354/);
});

test('選擇器文法跟文字規則的 scope 同一套（看不懂的一律拒絕，不是忽略）', () => {
  assert.ok(compileSelector('.card h2 > a, #main img').ok);

  for (const bad of ['h2:has(a)', 'a[href^="/x"]', 'p + p', '', '   ']) {
    assert.equal(compileSelector(bad).ok, false, `${bad} 不該編得過`);
  }
});

test('queryAll 不會配到文字節點（連 * 都不行）', () => {
  const root = parseDocument('<div>裸文字<span>x</span></div>');
  assert.deepEqual(
    queryAll(root, sel('*')).map((node) => node.tag),
    ['div', 'span'],
  );
});

test('script / style 的內容不當資料，裡面的 < 也不是標籤', () => {
  const root = parseDocument('<div><script>if (a<b) {}</script><p>真內容</p></div>');
  const [p] = queryAll(root, sel('div p'));

  assert.equal(valueOf(p, 'text'), '真內容');
});

test('屬性值裡的 > 不會被當成標籤結束', () => {
  const root = parseDocument('<a title="a > b" href="/x">文字</a>');
  const [a] = queryAll(root, sel('a'));

  assert.equal(valueOf(a, 'href'), '/x');
  assert.equal(valueOf(a, 'title'), 'a > b');
});

/* -------------------------------- 欄位 -------------------------------- */

const LISTING_HTML = `
  <div class="wrap">
    <div class="card"><h2><a href="/item-11-alpha">11 Alpha</a></h2>
      <img src="/img/a.jpg"><div class="d">說明 A</div></div>
    <div class="card"><h2><a href="/item-12-beta">12 Beta</a></h2>
      <img src="/img/b.jpg"><div class="d">說明 B</div></div>
    <div class="paging"><span class="current">1</span>
      <a href="/page/2">2</a><a href="/page/2">Next</a>
      <span class="info">Page 1 of 9</span></div>
    <div class="paging"><a href="/tag/red">紅</a><a href="/tag/blue">藍</a></div>
  </div>`;

const LISTING_CONFIG = [
  {
    kind: 'listing',
    match: '^/(page/\\d+)?$',
    item: '.card',
    id: '/item-(\\d+)',
    fields: {
      name: { sel: 'h2 a', attr: 'text' },
      url: { sel: 'h2 a', attr: 'href', as: 'url' },
      image: { sel: 'img', attr: 'src', as: 'url' },
      desc: { sel: '.d', attr: 'text' },
    },
    page: {
      page: { sel: '.paging .current', attr: 'text', as: 'number' },
      totalPages: { sel: '.info', attr: 'text', extract: 'of (\\d+)', as: 'number' },
      pages: { sel: '.paging a', as: 'link', many: true, when: { attr: 'href', match: 'page/\\d+' } },
      categories: { sel: 'a', as: 'link', many: true, when: { attr: 'href', match: '^/tag/' } },
    },
  },
];

function extractListing(html = LISTING_HTML, config = LISTING_CONFIG, pathname = '/page/1') {
  const compiled = compileConfig(config);
  assert.ok(compiled.ok, compiled.error);

  const entry = findEntry(compiled.value, pathname);
  assert.ok(entry, '應該有一筆設定命中');

  return extractData(html, { entry, ...SITE, pathname });
}

test('listing：每一項跑一次 fields，網址換成代理路徑', () => {
  const { ok, data } = extractListing();

  assert.equal(ok, true);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items[0], {
    id: '11',
    name: '11 Alpha',
    url: '/p/shop/item-11-alpha',
    image: '/p/shop/img/a.jpg',
    desc: '說明 A',
    tags: [],
    stats: { views: null, downloads: null, addedAt: null },
  });
  assert.deepEqual({ page: data.page, totalPages: data.totalPages }, { page: 1, totalPages: 9 });
});

/**
 * ⛔ 地雷 61：上游把同一個 class 用在頁碼列**與**標籤列。
 * 分得出來的只有 href，而 `[href*=…]` 是選擇器文法明確拒絕的 —— 所以要 `when`。
 */
test('⛔ when 把「同選擇器但不同用途」的連結分開', () => {
  const { data } = extractListing();

  assert.deepEqual(
    data.pages.map((link) => link.name),
    ['2', 'Next'],
    '分頁不該混進標籤連結',
  );
  assert.deepEqual(
    data.categories.map((link) => link.name),
    ['紅', '藍'],
  );
});

/**
 * ⛔ 地雷 60：limit 砍的是**候選**，而 `when` 是之後才篩的。
 * 第一版把它當結果上限，於是標籤列只抓到前面幾個 —— 後面的根本沒被看過。
 */
test('⛔ many + when：要掃完整份文件，不是只看前 N 個候選', () => {
  const noise = Array.from({ length: 80 }, (_, i) => `<a href="/other/${i}">x</a>`).join('');
  const html = `<div class="wrap">${noise}<a href="/tag/late">最後一個標籤</a>${LISTING_HTML}</div>`;

  const { data } = extractListing(html);

  assert.ok(
    data.categories.some((link) => link.name === '最後一個標籤'),
    `排在 80 個雜訊後面的標籤被漏掉了：${data.categories.map((c) => c.name).join(',')}`,
  );
});

test('link 清單會去重（同名同網址才算同一個）', () => {
  const html = `
    <h1>標題</h1>
    <div class="paging"><a href="/tag/x">X</a><a href="/tag/x">X</a><a href="/tag/x">別名</a></div>`;

  const compiled = compileConfig([
    {
      kind: 'product',
      match: '^/$',
      fields: {
        name: { sel: 'h1', attr: 'text' },
        tags: { sel: '.paging a', as: 'link', many: true },
      },
    },
  ]);
  assert.ok(compiled.ok, compiled.error);

  const { ok, data } = extractData(html, { entry: compiled.value[0], ...SITE, pathname: '/' });

  assert.equal(ok, true);
  assert.deepEqual(data.tags.map((link) => link.name), ['X', '別名']);
});

/**
 * ⛔ 「連名字跟圖都沒有」的項不該畫出來 —— 那是選擇器配錯了，
 * 而一排空白卡片看起來像網站壞了，不像設定寫錯。
 */
test('抽不到名字也抽不到圖的「項」會被丟掉', () => {
  const html = '<div class="card"><span>只有雜訊</span></div><div class="card"><h2><a href="/x">真的</a></h2></div>';
  const compiled = compileConfig([
    {
      kind: 'listing',
      match: '^/$',
      item: '.card',
      fields: { name: { sel: 'h2 a', attr: 'text' } },
    },
  ]);

  const { data } = extractData(html, { entry: compiled.value[0], ...SITE, pathname: '/' });
  assert.deepEqual(data.items.map((item) => item.name), ['真的']);
});

/** 單值欄位是「第一個**有值的**候選」—— 不是第一個候選 */
test('單值欄位會跳過抽不出東西的候選', () => {
  const html = `
    <div class="box">
      <p>標籤：一 二 三</p>
      <p>這是一段說明文字</p>
      <p><strong>Views:</strong> 11,249 &nbsp; <strong>Downloads:</strong> 1,354</p>
    </div>`;

  const compiled = compileConfig([
    {
      kind: 'product',
      match: '^/p',
      fields: {
        name: { sel: '.box p', attr: 'text' },
        views: { sel: '.box p', attr: 'text', extract: 'Views:\\s*([\\d,]+)', as: 'number' },
        downloads: { sel: '.box p', attr: 'text', extract: 'Downloads:\\s*([\\d,]+)', as: 'number' },
      },
    },
  ]);
  assert.ok(compiled.ok, compiled.error);

  const { data } = extractData(html, { entry: compiled.value[0], ...SITE, pathname: '/p/1' });
  assert.equal(data.stats.views, 11249);
  assert.equal(data.stats.downloads, 1354);
});

/* ------------------------------ 失敗的形狀 ------------------------------ */

test('⛔ 抽不到任何一項 ＝ 失敗（不是畫一頁空版型）', () => {
  const result = extractListing(LISTING_HTML, [
    { ...LISTING_CONFIG[0], item: '.does-not-exist' },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reason, /抽不到/);
});

test('product 抽不到名稱 ＝ 失敗', () => {
  const compiled = compileConfig([
    { kind: 'product', match: '^/p', fields: { name: { sel: '.nope', attr: 'text' } } },
  ]);
  const result = extractData('<div></div>', { entry: compiled.value[0], ...SITE, pathname: '/p/1' });

  assert.equal(result.ok, false);
});

test('缺欄位不是錯誤：缺 gallery 用 image 補、缺 stats 就是 null', () => {
  const compiled = compileConfig([
    {
      kind: 'product',
      match: '^/p',
      fields: { name: { sel: 'h1', attr: 'text' }, image: { sel: 'img', attr: 'src', as: 'url' } },
    },
  ]);

  const { ok, data } = extractData('<h1>名字</h1><img src="/a.jpg">', {
    entry: compiled.value[0],
    ...SITE,
    pathname: '/p/1',
  });

  assert.equal(ok, true);
  assert.deepEqual(data.gallery, ['/p/shop/a.jpg']);
  assert.deepEqual(data.stats, { views: null, downloads: null, addedAt: null });
  assert.deepEqual(data.links, { preview: null, download: null });
});

test('沒有一筆設定命中 ＝ findEntry 回 null（呼叫端會退回代理模式）', () => {
  const compiled = compileConfig(LISTING_CONFIG);

  assert.equal(findEntry(compiled.value, '/about'), null);
  assert.ok(findEntry(compiled.value, '/page/3'));
  // ⛔ 帶 g 旗標的正則會記住 lastIndex —— 連續比對必須每次都回一樣的答案
  assert.ok(findEntry(compiled.value, '/page/3'));
  assert.ok(findEntry(compiled.value, '/page/3'));
});

test('設定編不過時帶著「是哪一筆、哪個欄位」回去', () => {
  const broken = compileConfig([
    { kind: 'listing', match: '^/$', fields: { name: { sel: 'h2:has(a)' } } },
  ]);

  assert.equal(broken.ok, false);
  assert.match(broken.error, /\[0\]\.fields\.name\.sel/);

  assert.equal(compileConfig('{ 這不是 JSON').ok, false);
  assert.equal(compileConfig([{ kind: 'nope', match: '^/$', fields: {} }]).ok, false);
  // 空設定不是錯誤，只是「沒有設定」
  assert.deepEqual(compileConfig(null), { ok: true, value: [] });
});

/* -------------------------------- 網址 -------------------------------- */

test('⛔ 只有指向這個站的網址留得下來，其他一律丟掉', () => {
  const context = { siteId: 'shop', targetOrigin: 'https://upstream.test', pathname: '/a/b' };

  assert.equal(toProxied('/img/x.jpg', context), '/p/shop/img/x.jpg');
  assert.equal(toProxied('https://upstream.test/x?q=1', context), '/p/shop/x?q=1');
  assert.equal(toProxied('c.jpg', context), '/p/shop/a/c.jpg', '相對路徑要先解析');
  assert.equal(toProxied('#tab', context), '#tab');

  // 外站、javascript:、空的 → 空字串（＝這個欄位沒抽到，版型就不畫）
  assert.equal(toProxied('https://evil.test/x.jpg', context), '');
  assert.equal(toProxied('javascript:alert(1)', context), '');
  assert.equal(toProxied('   ', context), '');
});

/* -------------------------------- 價格 -------------------------------- */

/**
 * ⛔ 預設**只有一檔**（SPEC-reskin-v2 §3：「別分什麼個人企業，也別寫什麼
 * 授權的鬼」）。多檔的 headline 邏輯還在（資料結構留著），所以兩種都釘。
 */
test('價格：預設只有一檔；多檔時 headline 是最便宜的付費方案', () => {
  const { ok, value } = compilePricing(null);

  assert.equal(ok, true);
  assert.deepEqual(value.plans, [...DEFAULT_PLANS]);
  assert.equal(value.plans.length, 1, '預設不准長出第二檔');
  assert.deepEqual(headlinePrice(value.plans), { price: 199, originalPrice: null, hasFree: false });

  const tiered = compilePricing({
    plans: [
      { id: 'free', name: '免費', price: 0 },
      { id: 'one', name: '單檔', price: 199 },
      { id: 'all', name: '全站', price: 699 },
    ],
  });

  assert.equal(tiered.ok, true);
  assert.deepEqual(headlinePrice(tiered.value.plans), {
    price: 199,
    originalPrice: 699,
    hasFree: true,
  });
});

test('價格：壞掉的方案會被擋下來（這是表單填的，不是手寫的）', () => {
  assert.equal(compilePricing({ plans: [] }).ok, false);
  assert.equal(compilePricing({ plans: [{ id: 'a', name: 'A', price: -1 }] }).ok, false);
  assert.equal(compilePricing({ plans: [{ id: '壞 id', name: 'A', price: 1 }] }).ok, false);
  assert.equal(
    compilePricing({ plans: [{ id: 'a', name: 'A', price: 1 }, { id: 'a', name: 'B', price: 2 }] }).ok,
    false,
    'id 重複要擋',
  );

  const good = compilePricing({ currency: 'US$', plans: [{ id: 'x', name: '方案', price: 9.6 }] });
  assert.equal(good.ok, true);
  assert.equal(good.value.currency, 'US$');
  assert.equal(good.value.plans[0].price, 10, '小數要整數化');
});
