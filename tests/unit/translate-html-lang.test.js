'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteHtmlLang } = require('../../src/translate/html-lang.js');

/**
 * 內容已經是繁體中文、卻還宣告 `lang="en"` 的文件，瀏覽器會用預設的 CJK
 * 回退字體（常常是日文字形）—— 同一個漢字的寫法會不一樣。螢幕閱讀器也會
 * 用英文去念。規格沒提這件事，是驗收時在真瀏覽器上看到的。
 */

test('把 lang 換成目標語言', () => {
  assert.equal(
    rewriteHtmlLang('<!doctype html><html lang="en"><body>x</body></html>', 'zh-TW'),
    '<!doctype html><html lang="zh-TW"><body>x</body></html>',
  );
});

test('單引號、屬性順序、其他屬性都保住', () => {
  assert.equal(
    rewriteHtmlLang("<html class=\"no-js\" lang='en-US' dir=\"ltr\">", 'zh-TW'),
    '<html class="no-js" lang=\'zh-TW\' dir="ltr">',
  );
});

test('已經是目標語言就原樣回去（不要製造無謂的差異）', () => {
  const html = '<html lang="zh-TW"><body>x</body></html>';
  assert.equal(rewriteHtmlLang(html, 'zh-TW'), html);
});

test('⛔ 本來就沒宣告 lang 的不補（沒宣告與宣告錯的瀏覽器行為不一樣）', () => {
  const html = '<!doctype html><html><body>x</body></html>';
  assert.equal(rewriteHtmlLang(html, 'zh-TW'), html);
});

test('沒有 <html> 標籤（片段 HTML）不會爆', () => {
  assert.equal(rewriteHtmlLang('<p>hi</p>', 'zh-TW'), '<p>hi</p>');
});

test('只動第一個 <html>，後面文字裡出現的同樣字串不碰', () => {
  const html = '<html lang="en"><body>&lt;html lang="en"&gt; 是這樣寫的</body></html>';

  assert.equal(
    rewriteHtmlLang(html, 'zh-TW'),
    '<html lang="zh-TW"><body>&lt;html lang="en"&gt; 是這樣寫的</body></html>',
  );
});

test('非字串 / 空目標語言一律原樣', () => {
  assert.equal(rewriteHtmlLang(null, 'zh-TW'), null);
  assert.equal(rewriteHtmlLang('<html lang="en">', ''), '<html lang="en">');
  assert.equal(rewriteHtmlLang('<html lang="en">', null), '<html lang="en">');
});
