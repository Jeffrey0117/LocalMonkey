'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  segmentHtml,
  SKIP_ELEMENTS,
  TRANSLATABLE_ATTRIBUTES,
} = require('../../src/translate/segment.js');

/**
 * 規格 §3：伺服器端沒有 DOM，所以用狀態機掃描器切段。
 *
 * 這支測的是**座標**：每一段的 `start`/`end` 必須剛好框住原文那幾個字元，
 * 因為回填是 `html.slice(0, start) + 新的 + html.slice(end)`。
 * 座標錯掉的症狀是版面爆開，而且 curl 看起來「有翻譯」。
 */

/** 用回來的座標把原文切出來，證明 start/end 真的對準（而不是只有 raw 字串對） */
function slices(html) {
  return segmentHtml(html).map((segment) => html.slice(segment.start, segment.end));
}

function texts(html) {
  return segmentHtml(html)
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.raw);
}

test('最簡單的情形：標籤之間的文字就是一段', () => {
  const html = '<p>Hello world</p>';
  const segments = segmentHtml(html);

  assert.equal(segments.length, 1);
  assert.deepEqual(
    { ...segments[0] },
    { start: 3, end: 14, raw: 'Hello world', kind: 'text', element: 'p' },
  );
  assert.equal(html.slice(3, 14), 'Hello world');
});

test('座標真的對準原文（raw 一定等於 slice）', () => {
  const html = '<h1 class="a">Our Team</h1>\n<p>We build <b>things</b> daily.</p>';

  for (const segment of segmentHtml(html)) {
    assert.equal(html.slice(segment.start, segment.end), segment.raw);
  }
});

test('前後空白留在段裡（回填時要原樣放回去，不然版面會垮）', () => {
  const html = '<p>\n      Hello world\n    </p>';
  const segments = texts(html);

  assert.deepEqual(segments, ['\n      Hello world\n    ']);
});

test('巢狀標籤：一個元素裡被子標籤切開的文字算多段', () => {
  const html = '<p>Learn <strong>HTML</strong> and CSS today</p>';

  assert.deepEqual(texts(html), ['Learn ', 'HTML', ' and CSS today']);
  assert.deepEqual(slices(html), ['Learn ', 'HTML', ' and CSS today']);
});

/* ------------------------------ 跳過區 ------------------------------ */

test('⛔ script / style / pre / code / textarea / svg 的內容完全不切段', () => {
  for (const element of ['script', 'style', 'pre', 'code', 'textarea', 'svg']) {
    const html = `<div>Before</div><${element}>Do not translate me</${element}><div>After</div>`;
    assert.deepEqual(texts(html), ['Before', 'After'], element);
  }

  assert.deepEqual([...SKIP_ELEMENTS].sort(), [
    'code',
    'iframe',
    'noscript',
    'pre',
    'script',
    'style',
    'svg',
    'template',
    'textarea',
  ]);
});

test('跳過區裡出現 `<` 與假的標籤也不會把掃描器帶歪', () => {
  const html = '<p>A</p><script>if (a < b && c > d) { x("</div>") }</script><p>B</p>';
  assert.deepEqual(texts(html), ['A', 'B']);
});

test('HTML 註解整段跳過（包含註解裡的標籤）', () => {
  const html = '<p>Real</p><!-- <p>Commented out</p> --><p>Also real</p>';
    assert.deepEqual(texts(html), ['Real', 'Also real']);
});

test('doctype 與 XML 宣告不算文字', () => {
  const html = '<!doctype html><html><body><p>Hi there</p></body></html>';
  assert.deepEqual(texts(html), ['Hi there']);
});

/* ------------------------------ 屬性 ------------------------------ */

test('alt / title / placeholder / aria-label 會被切出來，並記下是哪個屬性', () => {
  const html =
    '<img src="/a.png" alt="A cat" title="Tooltip text">' +
    '<input placeholder="Your name" aria-label="Name field">';

  const attributes = segmentHtml(html)
    .filter((segment) => segment.kind === 'attribute')
    .map((segment) => [segment.attribute, segment.raw]);

  assert.deepEqual(attributes, [
    ['alt', 'A cat'],
    ['title', 'Tooltip text'],
    ['placeholder', 'Your name'],
    ['aria-label', 'Name field'],
  ]);
  assert.deepEqual([...TRANSLATABLE_ATTRIBUTES].sort(), [
    'alt',
    'aria-label',
    'placeholder',
    'title',
  ]);
});

test('屬性的座標也要對準（值在引號裡面，不含引號本身）', () => {
  const html = '<img alt="A cat">';
  const segment = segmentHtml(html)[0];

  assert.equal(html.slice(segment.start, segment.end), 'A cat');
  assert.equal(html[segment.start - 1], '"');
  assert.equal(html[segment.end], '"');
});

test('單引號的屬性值一樣吃得到', () => {
  const html = "<img alt='A dog'>";
  assert.deepEqual(slices(html), ['A dog']);
});

test('⛔ href / src / class / id / data-* 一律不切（規格 §3：不准碰）', () => {
  const html =
    '<a href="/about-us" class="nav-link big" id="about" data-title="Secret" rel="next">Link text</a>';

  assert.deepEqual(
    segmentHtml(html).map((segment) => segment.raw),
    ['Link text'],
  );
});

test('<title> 的內容是普通文字節點，所以自然會被切到', () => {
  const html = '<head><title>Templatemo Cyborg</title></head>';
  const segment = segmentHtml(html)[0];

  assert.equal(segment.raw, 'Templatemo Cyborg');
  assert.equal(segment.element, 'title');
});

test('<meta name="description"> 的 content 要切，其他 meta 不要', () => {
  const html =
    '<meta charset="utf-8">' +
    '<meta name="description" content="A free template for everyone">' +
    '<meta name="keywords" content="html, css, free">' +
    '<meta name="viewport" content="width=device-width">';

  assert.deepEqual(
    segmentHtml(html).map((segment) => [segment.attribute, segment.raw]),
    [['content', 'A free template for everyone']],
  );
});

test('meta description 的 name 大小寫、屬性順序顛倒都認得', () => {
  const html = '<meta CONTENT="Hello there" NAME="Description">';
  assert.deepEqual(slices(html), ['Hello there']);
});

/* --------------------------- 壞掉的 HTML --------------------------- */

test('⛔ 沒有結束標籤的壞 HTML 不會爆，而且不會吃掉剩下的文件', () => {
  for (const html of [
    '<p>Unclosed paragraph',
    '<div><p>Hello world',
    '<script>var a = 1;',          // 跳過區沒有結束標籤
    '<!-- never closed',
    '<img alt="unclosed quote>Text',
    '<',
    '<<<>>>',
    '',
  ]) {
    assert.doesNotThrow(() => segmentHtml(html), JSON.stringify(html));

    for (const segment of segmentHtml(html)) {
      assert.equal(html.slice(segment.start, segment.end), segment.raw, JSON.stringify(html));
    }
  }

  assert.deepEqual(texts('<p>Unclosed paragraph'), ['Unclosed paragraph']);
  assert.deepEqual(texts('<script>var a = 1;'), []);
});

test('非字串輸入回空陣列（不要讓一個壞回應弄掉整個代理）', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.deepEqual(segmentHtml(input), []);
  }
});

test('純空白的文字節點不進清單（省掉後面每一步的無用功）', () => {
  assert.deepEqual(texts('<div>\n  \t\n</div>'), []);
  assert.deepEqual(texts('<div> </div><p>x</p>'), ['x']);
});

test('段落依位置遞增、互不重疊（回填靠這個前提）', () => {
  const html =
    '<img alt="One"><p>Two</p><div title="Three">Four <span>Five</span></div><title>Six</title>';
  const segments = segmentHtml(html);

  assert.equal(segments.length, 6);

  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(
      segments[index].start >= segments[index - 1].end,
      `第 ${index} 段跟前一段重疊了`,
    );
  }
});
