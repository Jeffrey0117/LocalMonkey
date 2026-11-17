'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAnchorHrefs,
  normalizeCrawlPath,
  collectCrawlTargets,
  SKIP_EXTENSIONS,
} = require('../../src/translate/crawl-links.js');

/** 規格 §6：只爬同一個 target_origin、只跟 `<a href>`、跳過非 HTML。 */

const ORIGIN = 'https://templatemo.com';

test('只撈 <a> 的 href（不跟 link / script / img / form）', () => {
  const html = [
    '<a href="/about">About</a>',
    '<link rel="stylesheet" href="/style.css">',
    '<script src="/app.js"></script>',
    '<img src="/a.png">',
    '<form action="/search"></form>',
    "<a href='/contact'>Contact</a>",
    '<a class="btn" href="/pricing" title="x">Pricing</a>',
  ].join('\n');

  assert.deepEqual(extractAnchorHrefs(html), ['/about', '/contact', '/pricing']);
});

test('沒有 href、沒引號的 href 一律跳過（跟專案既有的保守政策一致）', () => {
  assert.deepEqual(extractAnchorHrefs('<a>no href</a><a href=/bare>bare</a>'), []);
});

test('非字串輸入回空陣列', () => {
  for (const input of [null, undefined, 42, {}]) {
    assert.deepEqual(extractAnchorHrefs(input), []);
  }
});

/* --------------------------- 正規化與過濾 --------------------------- */

test('相對路徑照 basePath 解開', () => {
  assert.equal(normalizeCrawlPath('about.html', { origin: ORIGIN, basePath: '/page/' }), '/page/about.html');
  assert.equal(normalizeCrawlPath('/about.html', { origin: ORIGIN, basePath: '/page/' }), '/about.html');
  assert.equal(normalizeCrawlPath('../x.html', { origin: ORIGIN, basePath: '/a/b/' }), '/a/x.html');
});

test('⛔ 只爬同一個 origin（外站一律跳過）', () => {
  for (const href of [
    'https://example.com/x',
    'http://templatemo.com/x', // scheme 不同就是不同 origin
    '//cdn.example.com/x',
  ]) {
    assert.equal(normalizeCrawlPath(href, { origin: ORIGIN, basePath: '/' }), null, href);
  }

  assert.equal(normalizeCrawlPath(`${ORIGIN}/about`, { origin: ORIGIN, basePath: '/' }), '/about');
});

test('⛔ mailto / tel / javascript / data 一律跳過', () => {
  for (const href of [
    'mailto:info@example.com',
    'tel:+886912345678',
    'javascript:void(0)',
    'data:text/html,<p>x</p>',
  ]) {
    assert.equal(normalizeCrawlPath(href, { origin: ORIGIN, basePath: '/' }), null, href);
  }
});

test('⛔ 有副檔名的非 HTML 跳過（規格 §6）', () => {
  for (const href of [
    '/files/report.pdf',
    '/download/pack.zip',
    '/img/hero.jpg',
    '/img/hero.PNG',
    '/video/clip.mp4',
    '/style.css',
    '/app.js',
    '/feed.xml',
    '/data.json',
  ]) {
    assert.equal(normalizeCrawlPath(href, { origin: ORIGIN, basePath: '/' }), null, href);
  }

  // HTML 的副檔名當然要爬
  for (const href of ['/about.html', '/about.htm', '/about.php', '/about/', '/about']) {
    assert.ok(normalizeCrawlPath(href, { origin: ORIGIN, basePath: '/' }), href);
  }

  assert.ok(SKIP_EXTENSIONS.has('pdf'));
  assert.ok(SKIP_EXTENSIONS.has('zip'));
  assert.ok(SKIP_EXTENSIONS.has('jpg'));
});

test('⛔ 丟掉 query 與 hash（規格 §6：query 不同但路徑相同的算同一頁）', () => {
  assert.equal(normalizeCrawlPath('/list?page=2', { origin: ORIGIN, basePath: '/' }), '/list');
  assert.equal(normalizeCrawlPath('/about#team', { origin: ORIGIN, basePath: '/' }), '/about');
  assert.equal(normalizeCrawlPath('#team', { origin: ORIGIN, basePath: '/about' }), '/about');
});

test('壞掉的 href 不會爆', () => {
  for (const href of ['', '   ', 'http://', '://x', null, undefined, 42]) {
    assert.doesNotThrow(() => normalizeCrawlPath(href, { origin: ORIGIN, basePath: '/' }));
  }
});

/* ------------------------------ 整頁 ------------------------------ */

test('collectCrawlTargets：去重、保留出現順序', () => {
  const html = [
    '<a href="/about">a</a>',
    '<a href="/about?x=1">b</a>',   // 同路徑，去重
    '<a href="/about#team">c</a>',  // 同路徑，去重
    '<a href="/contact">d</a>',
    '<a href="https://example.com/out">e</a>',
    '<a href="/files/x.pdf">f</a>',
  ].join('\n');

  assert.deepEqual(collectCrawlTargets(html, { origin: ORIGIN, basePath: '/' }), [
    '/about',
    '/contact',
  ]);
});

test('collectCrawlTargets：連回自己那一頁也會出現（呼叫端用 visited 去掉）', () => {
  const html = '<a href="/about">self</a><a href="/next">next</a>';

  assert.deepEqual(collectCrawlTargets(html, { origin: ORIGIN, basePath: '/about' }), [
    '/about',
    '/next',
  ]);
});
