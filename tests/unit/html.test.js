'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteRootPaths, injectScripts, scriptTag } = require('../../src/lib/html.js');

test('根絕對路徑的 src / href / action 被改寫成 /p/<siteId>/...', () => {
  const html = [
    '<script src="/assets/app.js"></script>',
    "<img src='/img/a.png'>",
    '<a href="/about">about</a>',
    '<link rel="stylesheet" href="/style.css">',
    '<form action="/search"></form>',
  ].join('\n');

  const out = rewriteRootPaths(html, 'demo');

  assert.ok(out.includes('src="/p/demo/assets/app.js"'));
  assert.ok(out.includes("src='/p/demo/img/a.png'"));
  assert.ok(out.includes('href="/p/demo/about"'));
  assert.ok(out.includes('href="/p/demo/style.css"'));
  assert.ok(out.includes('action="/p/demo/search"'));
});

test('protocol-relative（//cdn/x.js）不動', () => {
  const html = '<script src="//cdn.test/x.js"></script>';
  assert.equal(rewriteRootPaths(html, 'demo'), html);
});

test('完整網址不動', () => {
  const html = '<a href="https://x.test/y">y</a><img src="http://z.test/a.png">';
  assert.equal(rewriteRootPaths(html, 'demo'), html);
});

test('相對路徑、錨點、特殊 scheme 不動', () => {
  const html = [
    '<a href="about.html">x</a>',
    '<a href="#top">top</a>',
    '<a href="?page=2">next</a>',
    '<a href="mailto:a@b.test">mail</a>',
    '<a href="javascript:void(0)">js</a>',
    '<img src="data:image/png;base64,AAAA">',
  ].join('\n');
  assert.equal(rewriteRootPaths(html, 'demo'), html);
});

test('已經改寫過的路徑不會被二次改寫', () => {
  const html = '<script src="/p/demo/assets/app.js"></script>';
  assert.equal(rewriteRootPaths(html, 'demo'), html);
});

test('srcset 的每個候選都被改寫，跨域候選保留', () => {
  const html = '<img srcset="/a.png 1x, /b.png 2x, //cdn.test/c.png 3x, https://x.test/d.png 4x">';
  const out = rewriteRootPaths(html, 'demo');
  assert.ok(out.includes('/p/demo/a.png 1x'));
  assert.ok(out.includes('/p/demo/b.png 2x'));
  assert.ok(out.includes('//cdn.test/c.png 3x'));
  assert.ok(out.includes('https://x.test/d.png 4x'));
});

test('等號前後有空白、大寫屬性名也要處理', () => {
  const out = rewriteRootPaths('<script SRC = "/a.js"></script>', 'demo');
  assert.ok(out.includes('"/p/demo/a.js"'));
});

test('純文字裡的斜線不會被亂改', () => {
  const html = '<p>路徑是 /assets/app.js 喔</p>';
  assert.equal(rewriteRootPaths(html, 'demo'), html);
});

test('scriptTag 產生可被快取的外部 script 標籤', () => {
  assert.equal(scriptTag('scr_abc'), '<script src="/__lm/script/scr_abc.js"></script>');
});

test('head-end 插在 </head> 前，body-end 插在 </body> 前', () => {
  const html = '<html><head><title>t</title></head><body><p>hi</p></body></html>';
  const out = injectScripts(html, {
    head: [{ id: 'h1' }],
    body: [{ id: 'b1' }],
  });

  assert.ok(out.indexOf('/__lm/script/h1.js') < out.indexOf('</head>'));
  assert.ok(out.indexOf('/__lm/script/b1.js') > out.indexOf('</head>'));
  assert.ok(out.indexOf('/__lm/script/b1.js') < out.lastIndexOf('</body>'));
});

test('注入順序照傳進來的陣列順序（呼叫端已依 order_index 排好）', () => {
  const out = injectScripts('<html><body></body></html>', {
    head: [],
    body: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
  });
  assert.ok(out.indexOf('first.js') < out.indexOf('second.js'));
  assert.ok(out.indexOf('second.js') < out.indexOf('third.js'));
});

test('沒有 </body> 的 HTML：append 到結尾', () => {
  const html = '<p>片段 HTML</p>';
  const out = injectScripts(html, { head: [], body: [{ id: 'b1' }] });
  assert.ok(out.startsWith('<p>片段 HTML</p>'));
  assert.ok(out.includes('/__lm/script/b1.js'));
});

test('沒有 </head> 的 HTML：head 腳本 append 到結尾', () => {
  const out = injectScripts('<body><p>x</p></body>', { head: [{ id: 'h1' }], body: [] });
  assert.ok(out.includes('/__lm/script/h1.js'));
  assert.ok(out.indexOf('/__lm/script/h1.js') > out.indexOf('</body>'));
});

test('沒有腳本時 HTML 原樣不動', () => {
  const html = '<html><body>x</body></html>';
  assert.equal(injectScripts(html, { head: [], body: [] }), html);
});

test('大寫 </BODY> 也找得到', () => {
  const out = injectScripts('<HTML><BODY>x</BODY></HTML>', { head: [], body: [{ id: 'b1' }] });
  assert.ok(out.indexOf('/__lm/script/b1.js') < out.indexOf('</BODY>'));
});

test('有多個 </body> 時插在最後一個之前', () => {
  const html = '<body><code>&lt;/body&gt;</code></body><!-- x --></body>';
  const out = injectScripts(html, { head: [], body: [{ id: 'b1' }] });
  assert.ok(out.indexOf('/__lm/script/b1.js') < out.lastIndexOf('</body>'));
});
