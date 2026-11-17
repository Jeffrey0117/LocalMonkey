'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { documentCharset, isUtf8Document } = require('../../src/translate/charset.js');
const { fromLatin1, toLatin1 } = require('../../src/translate/bytes.js');

/**
 * 為什麼需要這一層：
 *
 * 代理的 HTML 改寫一律走 latin1（byte-lossless，所以不用猜頁面的 charset）。
 * 原本插進去的東西全是 ASCII，所以永遠安全 —— 但**翻譯會插入中文**，
 * 中文的 byte 表示法跟頁面宣告的 charset 綁在一起。
 *
 * 所以規則是：**只有明確宣告 UTF-8 的文件才翻**。
 * 沒宣告的不翻（瀏覽器會自己猜 charset，猜錯就是整頁亂碼）。
 * 規格沒提這件事，這是實作時補上的安全邊界。
 */

test('content-type header 的 charset 優先（那是權威來源）', () => {
  assert.equal(documentCharset('<html></html>', 'text/html; charset=utf-8'), 'utf-8');
  assert.equal(documentCharset('<html></html>', 'text/html; charset=Big5'), 'big5');
  assert.equal(
    documentCharset('<meta charset="big5">', 'text/html; charset=utf-8'),
    'utf-8',
    'header 贏過 meta',
  );
});

test('header 沒帶就看 <meta charset>', () => {
  assert.equal(documentCharset('<head><meta charset="utf-8"></head>', 'text/html'), 'utf-8');
  assert.equal(documentCharset("<meta charset='UTF-8'>", null), 'utf-8');
  assert.equal(documentCharset('<meta charset="big5">', undefined), 'big5');
});

test('舊寫法的 meta http-equiv 也要認', () => {
  const html = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
  assert.equal(documentCharset(html, null), 'utf-8');
});

test('什麼都沒宣告 → null', () => {
  assert.equal(documentCharset('<html><body>hi</body></html>', 'text/html'), null);
  assert.equal(documentCharset('', null), null);
});

test('⛔ 只看文件開頭（charset 宣告晚於 1KB 時瀏覽器自己也不理）', () => {
  const late = `${'<!-- padding -->'.repeat(400)}<meta charset="utf-8">`;
  assert.equal(documentCharset(late, null), null);
});

test('isUtf8Document：只有明確的 UTF-8 才算（別名也算）', () => {
  assert.equal(isUtf8Document('<meta charset="utf-8">', null), true);
  assert.equal(isUtf8Document('<meta charset="UTF8">', null), true);
  assert.equal(isUtf8Document('<meta charset="unicode-1-1-utf-8">', null), true);

  assert.equal(isUtf8Document('<meta charset="big5">', null), false);
  assert.equal(isUtf8Document('<meta charset="iso-8859-1">', null), false);
  assert.equal(isUtf8Document('<html>no declaration</html>', null), false);
});

/* ----------------------------- latin1 橋 ----------------------------- */

test('fromLatin1 / toLatin1 是互逆的（代理管線在 latin1 上工作）', () => {
  for (const text of ['Hello', '繁體中文', '聯絡我們 Contact', 'emoji 🙂']) {
    assert.equal(fromLatin1(toLatin1(text)), text, text);
  }
});

test('⛔ toLatin1 出來的字串放回 Buffer 要是正確的 UTF-8 byte', () => {
  const latin1 = toLatin1('聯絡');
  const bytes = Buffer.from(latin1, 'latin1');

  assert.equal(bytes.toString('utf8'), '聯絡');
  assert.equal(bytes.length, 6, '兩個中文字 = 6 個 UTF-8 byte');
});

test('fromLatin1 吃到不是 UTF-8 的 byte 會得到替換字元（rules 會因此跳過那段）', () => {
  const big5Bytes = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // Big5 的「中文」
  const decoded = fromLatin1(big5Bytes.toString('latin1'));

  assert.ok(decoded.includes(String.fromCharCode(0xfffd)));
});
