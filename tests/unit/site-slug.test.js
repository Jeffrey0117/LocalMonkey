'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { slugForHost, uniqueSlug } = require('../../src/services/site-slug.js');
const { SLUG_PATTERN, RESERVED_SLUGS } = require('../../src/lib/validate.js');

test('主機名變成合法的 slug', () => {
  assert.equal(slugForHost('example.com'), 'example-com');
  assert.equal(slugForHost('seller.shopee.tw'), 'seller-shopee-tw');
});

test('開頭的 www. 砍掉（沒人想看 www-example-com）', () => {
  assert.equal(slugForHost('www.example.com'), 'example-com');
  assert.equal(slugForHost('www2.example.com'), 'www2-example-com', '只砍剛好是 www 的那一段');
});

test('port 保留但換成連字號', () => {
  assert.equal(slugForHost('localhost:3000'), 'localhost-3000');
});

test('大寫轉小寫、底線與其他符號收斂成連字號', () => {
  assert.equal(slugForHost('My_Site.Example.COM'), 'my-site-example-com');
});

test('連續符號不會變成連續連字號，頭尾也不留連字號', () => {
  assert.equal(slugForHost('--a..b--'), 'a-b');
});

test('長度砍到 40 以內，而且結尾不留連字號', () => {
  const slug = slugForHost(`${'a'.repeat(30)}.${'b'.repeat(30)}.com`);

  assert.ok(slug.length <= 40, `長度 ${slug.length}`);
  assert.ok(SLUG_PATTERN.test(slug), slug);
  assert.equal(slug.endsWith('-'), false);
});

test('產生的 slug 一定過得了 v1 的格式檢查', () => {
  for (const host of ['a.test', 'xn--fiqs8s.com', '1.2.3.4', 'localhost', 'ü.example.com']) {
    const slug = slugForHost(host);
    assert.ok(SLUG_PATTERN.test(slug), `${host} → ${slug}`);
  }
});

test('算不出東西時退回 site', () => {
  for (const host of ['', '...', '---', null, undefined, 42]) {
    assert.equal(slugForHost(host), 'site', JSON.stringify(host));
  }
});

test('撞到保留字會被改掉', () => {
  for (const reserved of RESERVED_SLUGS) {
    const slug = slugForHost(reserved);
    assert.equal(RESERVED_SLUGS.has(slug), false, `${reserved} → ${slug}`);
    assert.ok(SLUG_PATTERN.test(slug), slug);
  }
});

test('uniqueSlug：沒撞到就原樣回傳', () => {
  assert.equal(uniqueSlug('example-com', () => false), 'example-com');
});

test('uniqueSlug：撞到就加數字後綴', () => {
  const taken = new Set(['example-com', 'example-com-2']);

  assert.equal(uniqueSlug('example-com', (slug) => taken.has(slug)), 'example-com-3');
});

test('uniqueSlug：後綴也要守住 40 字的上限', () => {
  const base = 'a'.repeat(40);
  const slug = uniqueSlug(base, (candidate) => candidate === base);

  assert.ok(slug.length <= 40, `長度 ${slug.length}`);
  assert.notEqual(slug, base);
  assert.ok(SLUG_PATTERN.test(slug), slug);
});

test('uniqueSlug：全部撞光時丟錯，不要無限迴圈', () => {
  assert.throws(() => uniqueSlug('x', () => true));
});
