'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { injectScripts, insertAtHeadStart } = require('../../src/lib/html.js');

const PAGE = [
  '<!doctype html>',
  '<html lang="zh">',
  '<head><script src="/page.js"></script><title>t</title></head>',
  '<body><p>hi</p></body>',
  '</html>',
].join('\n');

test('document-start 插在 <head> 的第一個子元素（而不是 </head> 之前）', () => {
  const out = insertAtHeadStart(PAGE, '<script src="/injected.js"></script>');

  assert.ok(
    out.indexOf('/injected.js') < out.indexOf('/page.js'),
    '要插在頁面自己的 script 之前，否則想 hook fetch 的腳本會失效',
  );
  assert.ok(out.indexOf('<head') < out.indexOf('/injected.js'));
});

test('<head> 帶屬性也找得到', () => {
  const out = insertAtHeadStart('<html><head class="a" data-x>…</head></html>', '<i></i>');
  assert.ok(out.includes('<head class="a" data-x><i></i>'));
});

test('大寫 <HEAD> 也找得到', () => {
  const out = insertAtHeadStart('<HTML><HEAD><TITLE>t</TITLE></HEAD></HTML>', '<i></i>');
  assert.ok(out.indexOf('<i></i>') < out.indexOf('<TITLE>'));
});

test('沒有 <head>：退到 <html> 之後', () => {
  const out = insertAtHeadStart('<html><body><p>x</p></body></html>', '<i></i>');

  assert.ok(out.startsWith('<html><i></i>'));
  assert.ok(out.indexOf('<i></i>') < out.indexOf('<body>'));
});

test('沒有 <head> 也沒有 <html>：退到 doctype 之後', () => {
  const out = insertAtHeadStart('<!doctype html>\n<p>片段</p>', '<i></i>');

  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(out.indexOf('<i></i>') < out.indexOf('<p>'));
  assert.ok(out.indexOf('<!doctype html>') < out.indexOf('<i></i>'), 'doctype 一定要留在最前面');
});

test('什麼標籤都沒有的片段：插在最前面', () => {
  assert.equal(insertAtHeadStart('<p>只有片段</p>', '<i></i>'), '<i></i>\n<p>只有片段</p>');
});

test('空 payload 不動 HTML', () => {
  assert.equal(insertAtHeadStart(PAGE, ''), PAGE);
});

test('injectScripts 支援三個位置，而且彼此不會打架', () => {
  const out = injectScripts(PAGE, {
    headStart: [{ src: '/early.js' }],
    head: [{ src: '/head-end.js' }],
    body: [{ src: '/late.js' }],
  });

  assert.ok(out.indexOf('/early.js') < out.indexOf('/page.js'), 'headStart 最早');
  assert.ok(out.indexOf('/page.js') < out.indexOf('/head-end.js'));
  assert.ok(out.indexOf('/head-end.js') < out.indexOf('</head>'));
  assert.ok(out.indexOf('</head>') < out.indexOf('/late.js'));
  assert.ok(out.indexOf('/late.js') < out.lastIndexOf('</body>'));
});

test('entry 可以用 {src} 指定任意路徑（shim 與 @require 的資產要用）', () => {
  const out = injectScripts('<html><body></body></html>', {
    body: [{ src: '/__lm/shim/scr_a.js' }, { src: '/__lm/asset/deadbeef.js' }],
  });

  assert.ok(out.includes('<script src="/__lm/shim/scr_a.js"></script>'));
  assert.ok(out.includes('<script src="/__lm/asset/deadbeef.js"></script>'));
});

test('entry 用 {id} 時維持 v1 的腳本投遞路徑', () => {
  const out = injectScripts('<html><body></body></html>', { body: [{ id: 'scr_x' }] });
  assert.ok(out.includes('<script src="/__lm/script/scr_x.js"></script>'));
});

test('src 會被轉義，不能用它跳出屬性值', () => {
  const out = injectScripts('<html><body></body></html>', {
    body: [{ src: '/x.js"></script><script>alert(1)</script><script src="' }],
  });

  assert.equal(out.includes('<script>alert(1)</script>'), false);
  assert.ok(out.includes('&quot;'));
});
