'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyTextRules } = require('../../src/rules/apply.js');
const { compileRules } = require('../../src/rules/compile.js');
const { fromLatin1, toLatin1 } = require('../../src/translate/bytes.js');

const rule = (overrides) => ({
  id: 'r1',
  kind: 'text-replace',
  pattern: 'templatemo',
  replacement: 'templatee',
  enabled: true,
  order_index: 0,
  ...overrides,
});

function run(html, rows, options = {}) {
  return applyTextRules(html, compileRules(rows), options);
}

test('文字節點會被改寫', () => {
  const result = run('<h1>Free templatemo templates</h1>', [rule({})]);
  assert.equal(result.html, '<h1>Free templatee templates</h1>');
  assert.equal(result.applied, 1);
});

test('⛔ href / src / class / id 不准被動到（規格 §6 的回歸保護）', () => {
  const html =
    '<a href="https://templatemo.com" class="templatemo-link" id="templatemo-a"' +
    ' data-x="templatemo">templatemo</a>' +
    '<img src="/images/templatemo-logo-new.png">';

  const result = run(html, [rule({})]);

  assert.match(result.html, /href="https:\/\/templatemo\.com"/);
  assert.match(result.html, /class="templatemo-link"/);
  assert.match(result.html, /id="templatemo-a"/);
  assert.match(result.html, /data-x="templatemo"/);
  assert.match(result.html, /src="\/images\/templatemo-logo-new\.png"/);
  assert.match(result.html, />templatee</);
});

test('alt / title / placeholder / aria-label 這些給人讀的屬性會改寫', () => {
  const html = '<img alt="templatemo free css templates" title="templatemo - free templates">';
  const result = run(html, [rule({})]);

  assert.equal(
    result.html,
    '<img alt="templatee free css templates" title="templatee - free templates">',
  );
});

test('屬性值裡的引號要跳脫，不然標籤會斷掉', () => {
  const html = '<img alt="a cat">';
  const result = run(html, [rule({ pattern: 'a cat', replacement: 'say "hi"' })]);

  assert.equal(result.html, '<img alt="say &quot;hi&quot;">');
});

test('<script> / <style> 裡的內容不會被動到', () => {
  const html = '<script>var a = "templatemo";</script><style>.templatemo{color:red}</style>';
  assert.equal(run(html, [rule({})]).html, html);
});

test('前後空白原樣放回（規格 §3：空白掉了版面會黏在一起）', () => {
  const result = run('<p>\n  templatemo\n</p>', [rule({})]);
  assert.equal(result.html, '<p>\n  templatee\n</p>');
});

test('大小寫風格跟著原文（TemplateMo → Templatee）', () => {
  const result = run('<p>© 2026 TemplateMo</p>', [rule({})]);
  assert.equal(result.html, '<p>© 2026 Templatee</p>');
});

test('entity 要先還原再比對（&amp; 不是三個字）', () => {
  const result = run('<p>A &amp; templatemo</p>', [rule({})]);
  assert.equal(result.html, '<p>A &amp; templatee</p>');
});

test('沒命中的段原封不動（連 entity 都不要重新編碼）', () => {
  const html = '<p>&copy; 2026 &nbsp; nothing to do</p>';
  assert.equal(run(html, [rule({})]).html, html);
});

test('scope 限定：只有卡片標題被改寫（規格 §3.2）', () => {
  const html =
    '<div class="thumbnail_270"><h2><a href="/x">634 Lantern River</a></h2></div>' +
    '<h1 class="title_2">620+ Free CSS Website Templates</h1>' +
    '<p>2026 is a good year</p>';

  const result = run(html, [
    rule({
      kind: 'text-rewrite',
      pattern: '^(\\d{2,4})\\s+(.+)$',
      replacement: '$2[$1]',
      scope: '.thumbnail_270 h2',
    }),
  ]);

  assert.match(result.html, />Lantern River\[634\]</);
  assert.match(result.html, />620\+ Free CSS Website Templates</);
  assert.match(result.html, />2026 is a good year</);
});

test('改寫成空字串＝把那一段刪掉（footer 的孤兒分隔符）', () => {
  const html = '<div id="footer">x - <a href="/about">About</a> - <a href="/contact">Contact</a></div>';

  const result = run(html, [
    rule({ kind: 'text-rewrite', pattern: '\\s*-\\s*$', replacement: '', scope: '#footer' }),
  ]);

  // 分隔符不見了，但原本的前後空白留著（HTML 會自己收掉連續空白，
  // 而把空白也吃掉會讓行內元素黏在一起 —— 規格 §3 點名的那個坑）
  assert.equal(
    result.html,
    '<div id="footer">x <a href="/about">About</a>  <a href="/contact">Contact</a></div>',
  );
});

test('latin1 管線：中文替換字要編回 byte 才塞得進去', () => {
  const source = Buffer.from('<h2> 免費 HTML CSS 網站模板</h2>', 'utf8').toString('latin1');

  const result = applyTextRules(
    source,
    compileRules([rule({ pattern: '免費 HTML CSS 網站模板', replacement: '超級齊全的 HTML CSS 網站模板' })]),
    { decode: fromLatin1, encode: toLatin1 },
  );

  assert.equal(
    Buffer.from(result.html, 'latin1').toString('utf8'),
    '<h2> 超級齊全的 HTML CSS 網站模板</h2>',
  );
});

test('沒有規則就原樣回傳（而且不要白跑一趟切段）', () => {
  const html = '<p>hello</p>';
  const result = run(html, []);

  assert.equal(result.html, html);
  assert.equal(result.applied, 0);
});

test('每條規則命中幾段要回報（控制台的「試一下」靠這個）', () => {
  const html = '<p>templatemo</p><p>templatemo</p><p>other</p>';
  const result = run(html, [rule({ id: 'tm' })]);

  assert.equal(result.hits.tm, 2);
});

test('一條壞規則不會讓整份 HTML 壞掉', () => {
  const html = '<p>templatemo</p>';
  const result = run(html, [
    rule({ id: 'bad', kind: 'text-rewrite', pattern: '(unclosed', order_index: 0 }),
    rule({ id: 'good', order_index: 1 }),
  ]);

  assert.equal(result.html, '<p>templatee</p>');
});

test('座標回填不會把 HTML 弄錯位（多段、交錯屬性與文字）', () => {
  const html =
    '<div><img alt="templatemo logo"><h2>templatemo</h2>' +
    '<p>by <b>templatemo</b> since 2008</p></div>';

  const result = run(html, [rule({})]);

  assert.equal(
    result.html,
    '<div><img alt="templatee logo"><h2>templatee</h2>' +
      '<p>by <b>templatee</b> since 2008</p></div>',
  );
});
