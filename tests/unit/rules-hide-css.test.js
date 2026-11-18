'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHideCss } = require('../../src/rules/hide-css.js');
const { injectStyleTag, LM_STYLE_ID } = require('../../src/rules/style-tag.js');
const { compileRules } = require('../../src/rules/compile.js');

const hide = (pattern, extra = {}) => ({
  id: `h-${pattern}`,
  kind: 'hide',
  pattern,
  enabled: true,
  order_index: 0,
  ...extra,
});

test('每條 hide 規則變成一條 display:none !important', () => {
  const css = buildHideCss(compileRules([hide('.tm-menu')]));

  assert.match(css, /\.tm-menu\s*\{[^}]*display:\s*none\s*!important/);
});

test('多條規則合併成一份 CSS', () => {
  const css = buildHideCss(compileRules([hide('.tm-menu'), hide('#footer a[href*="/about"]')]));

  assert.match(css, /\.tm-menu/);
  assert.match(css, /#footer a\[href\*="\/about"\]/);
});

test('停用與壞掉的規則不進 CSS', () => {
  const css = buildHideCss(
    compileRules([hide('.a', { enabled: false }), hide('b} *'), hide('.ok')]),
  );

  assert.doesNotMatch(css, /\.a\b/);
  assert.doesNotMatch(css, /\}\s*\*/);
  assert.match(css, /\.ok/);
});

test('沒有任何可用的 hide 規則 → 回 null（呼叫端就不要注入空的 style）', () => {
  assert.equal(buildHideCss([]), null);
  assert.equal(buildHideCss(compileRules([hide('.a', { enabled: false })])), null);
});

test('⛔ 產出的 CSS 一定是純 ASCII（注入點是 latin1 管線）', () => {
  const css = buildHideCss(compileRules([hide('a[title="聯絡我們"]')]));

  assert.match(css, /^[\x20-\x7e\n]*$/);
  assert.match(css, /\\00806f/);
});

/* --------------------------------- 注入位置 -------------------------------- */

test('style 插在 </head> 之前 —— 這樣既不閃爍，又贏得過站內的 !important', () => {
  const html = '<html><head><link rel="stylesheet" href="/a.css"></head><body>x</body></html>';
  const injected = injectStyleTag(html, '.a{display:none}');

  assert.match(injected, /<link[^>]*>\s*<style/);
  assert.match(injected, /<\/style>\s*<\/head>/);
  assert.equal(injected.includes(LM_STYLE_ID), true);
});

test('沒有 </head> 就退到 <head> 開頭，再退到整份文件最前面', () => {
  assert.match(injectStyleTag('<head><body>x', '.a{}'), /^<head><style/);
  assert.match(injectStyleTag('<p>x</p>', '.a{}'), /^<style/);
});

test('空 CSS 不注入任何東西', () => {
  const html = '<head></head>';
  assert.equal(injectStyleTag(html, null), html);
  assert.equal(injectStyleTag(html, ''), html);
});

test('注入的內容不會長出新的 tag（CSS 已經過選擇器檢查，這裡再釘一次）', () => {
  const injected = injectStyleTag('<head></head>', '.a{display:none}');
  assert.equal(injected.match(/<style/g).length, 1);
  assert.equal(injected.match(/<\/style>/g).length, 1);
});
