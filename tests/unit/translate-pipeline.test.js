'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectSegments,
  renderTranslated,
  uniqueTexts,
} = require('../../src/translate/pipeline.js');
const { toLatin1, fromLatin1 } = require('../../src/translate/bytes.js');

/**
 * 切段 → 篩選 → 回填的完整來回。
 *
 * 預設的 decode/encode 是 identity，所以這支測試用純 ASCII 就能把邏輯測完；
 * latin1 那一段（代理真正在用的）另外有專門的測試在最下面。
 */

/** 把一份對照表變成 resolve 函式 */
function lookupFrom(map) {
  return (text) => map[text] ?? null;
}

test('collectSegments：只留要翻的，附上前後空白與正規化後的文字', () => {
  const html = '<p>\n  Hello world\n</p><p>2026</p><img alt="A cat">';
  const items = collectSegments(html);

  assert.deepEqual(
    items.map((item) => ({ text: item.text, lead: item.lead, trail: item.trail, kind: item.kind })),
    [
      { text: 'Hello world', lead: '\n  ', trail: '\n', kind: 'text' },
      { text: 'A cat', lead: '', trail: '', kind: 'attribute' },
    ],
  );
});

test('collectSegments：連續空白在 text 裡被正規化（快取 key 才會命中）', () => {
  const items = collectSegments('<p>Hello     world</p>');

  assert.equal(items[0].text, 'Hello world');
  assert.equal(items[0].raw, 'Hello     world');
});

test('collectSegments：entity 先還原再給模型（規格 §3）', () => {
  const items = collectSegments('<p>Tom &amp; Jerry &lt;3</p>');

  assert.equal(items[0].text, 'Tom & Jerry <3');
});

test('collectSegments：術語表會往下傳（整段是術語的就不收）', () => {
  const html = '<p>Bootstrap</p><p>Built with Bootstrap</p>';
  const items = collectSegments(html, { glossary: ['Bootstrap'] });

  assert.deepEqual(items.map((item) => item.text), ['Built with Bootstrap']);
});

test('uniqueTexts：重複的段合成一筆（一頁裡 Read More 會出現十次）', () => {
  const items = collectSegments('<a>Read more</a><a>Read more</a><a>Contact us</a>');

  assert.equal(items.length, 3);
  assert.deepEqual(uniqueTexts(items), ['Read more', 'Contact us']);
});

/* ------------------------------ 回填 ------------------------------ */

test('renderTranslated：命中的換掉、沒命中的保留原文', () => {
  const html = '<p>Hello world</p><p>Goodbye world</p>';
  const items = collectSegments(html);

  const { html: output, applied } = renderTranslated(
    html,
    items,
    lookupFrom({ 'Hello world': '你好世界' }),
  );

  assert.equal(output, '<p>你好世界</p><p>Goodbye world</p>');
  assert.equal(applied, 1);
});

test('⛔ 回填保留原本的前後空白（不然版面會垮）', () => {
  const html = '<p>\n      Hello world\n    </p>';
  const items = collectSegments(html);

  const { html: output } = renderTranslated(html, items, lookupFrom({ 'Hello world': '你好世界' }));

  assert.equal(output, '<p>\n      你好世界\n    </p>');
});

test('⛔ 回填時重新編碼 entity（譯文裡的 & < > 不能破壞標記）', () => {
  const html = '<p>Terms and conditions</p>';
  const items = collectSegments(html);

  const { html: output } = renderTranslated(
    html,
    items,
    lookupFrom({ 'Terms and conditions': '條款 & <細則>' }),
  );

  assert.equal(output, '<p>條款 &amp; &lt;細則&gt;</p>');
});

test('⛔ 屬性的回填要用屬性模式編碼（譯文裡的引號會把標籤弄斷）', () => {
  const html = '<img alt="A cat">';
  const items = collectSegments(html);

  const { html: output } = renderTranslated(html, items, lookupFrom({ 'A cat': '一隻"貓"' }));

  assert.equal(output, '<img alt="一隻&quot;貓&quot;">');
});

test('多段一起換，座標不會互相推移', () => {
  const html = '<h1>Our Team</h1><p>We are hiring</p><img alt="Office photo"><p>Contact</p>';
  const items = collectSegments(html);

  const { html: output, applied } = renderTranslated(
    html,
    items,
    lookupFrom({
      'Our Team': '我們的團隊',
      'We are hiring': '我們正在招募',
      'Office photo': '辦公室照片',
      Contact: '聯絡我們',
    }),
  );

  assert.equal(
    output,
    '<h1>我們的團隊</h1><p>我們正在招募</p><img alt="辦公室照片"><p>聯絡我們</p>',
  );
  assert.equal(applied, 4);
});

test('⛔ 同一段文字出現多次 → 每一處都換（一頁十個 Read more）', () => {
  const html = '<a>Read more</a><b>x</b><a>Read more</a>';
  const items = collectSegments(html);

  const { html: output } = renderTranslated(html, items, lookupFrom({ 'Read more': '閱讀更多' }));

  assert.equal(output, '<a>閱讀更多</a><b>x</b><a>閱讀更多</a>');
});

test('沒有任何命中 → 回原本那個字串（連 identity 都不要重組）', () => {
  const html = '<p>Hello world</p>';
  const items = collectSegments(html);
  const { html: output, applied } = renderTranslated(html, items, () => null);

  assert.equal(output, html);
  assert.equal(applied, 0);
});

test('resolve 回空字串 / 非字串一律當沒命中（模型回垃圾時不要清掉版面）', () => {
  const html = '<p>Hello world</p>';
  const items = collectSegments(html);

  for (const bad of ['', '   ', 42, null, undefined, {}]) {
    const { html: output } = renderTranslated(html, items, () => bad);
    assert.equal(output, html, JSON.stringify(bad));
  }
});

test('⛔ script / style 的內容在整條管線裡都沒被動到', () => {
  const html =
    '<style>.a{content:"Hello world"}</style>' +
    '<p>Hello world</p>' +
    '<script>var t = "Hello world";</script>';

  const items = collectSegments(html);
  const { html: output } = renderTranslated(html, items, lookupFrom({ 'Hello world': '你好世界' }));

  assert.equal(
    output,
    '<style>.a{content:"Hello world"}</style><p>你好世界</p><script>var t = "Hello world";</script>',
  );
});

test('⛔ href / src / class 在整條管線裡都沒被動到（防過度修正的回歸保護）', () => {
  const html = '<a href="/contact" class="btn Contact" data-label="Contact">Contact</a>';
  const items = collectSegments(html);
  const { html: output } = renderTranslated(html, items, lookupFrom({ Contact: '聯絡我們' }));

  assert.equal(output, '<a href="/contact" class="btn Contact" data-label="Contact">聯絡我們</a>');
});

/* --------------------------- latin1 橋 --------------------------- */

test('⛔ 代理用的 latin1 模式：中文插進去還原回 Buffer 要是正確的 UTF-8', () => {
  const html = Buffer.from('<p>Contact</p>', 'utf8').toString('latin1');

  const items = collectSegments(html, { decode: fromLatin1 });
  const { html: output } = renderTranslated(html, items, lookupFrom({ Contact: '聯絡我們' }), {
    encode: toLatin1,
  });

  assert.equal(Buffer.from(output, 'latin1').toString('utf8'), '<p>聯絡我們</p>');
});

test('⛔ latin1 模式下，頁面上既有的中文要能原樣讀出來（才跳得掉）', () => {
  const html = Buffer.from('<p>已經是中文</p><p>Contact</p>', 'utf8').toString('latin1');
  const items = collectSegments(html, { decode: fromLatin1 });

  assert.deepEqual(items.map((item) => item.text), ['Contact']);
});
