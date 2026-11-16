'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isConnectAllowed } = require('../../src/lib/connect-policy.js');

function check(targetUrl, overrides = {}) {
  return isConnectAllowed({
    targetUrl: new URL(targetUrl),
    siteOrigin: 'https://shop.example.com',
    connect: [],
    connectAll: false,
    ...overrides,
  });
}

test('沒宣告 @connect → 只准打這個站自己的 origin', () => {
  assert.equal(check('https://shop.example.com/api/items').allowed, true);
  assert.equal(check('https://api.example.com/x').allowed, false);
});

test('站自己的 origin：path 與 query 無關，但換了主機或 scheme 就不算', () => {
  assert.equal(check('https://shop.example.com/').allowed, true);
  assert.equal(check('https://shop.example.com/a/b?c=1#d').allowed, true);
  assert.equal(check('http://shop.example.com/').allowed, false, 'scheme 不同就是不同 origin');
  assert.equal(check('https://other.example.com/').allowed, false);
});

test('帶 port 的站：origin 要完全一樣', () => {
  const options = { siteOrigin: 'http://localhost:3000' };
  assert.equal(check('http://localhost:3000/api', options).allowed, true);
  assert.equal(check('http://localhost:4000/api', options).allowed, false);
});

test('@connect 列出的主機放行，沒列的擋掉', () => {
  const connect = ['api.example.com', 'cdn.other.test'];

  assert.equal(check('https://api.example.com/v1', { connect }).allowed, true);
  assert.equal(check('https://cdn.other.test/a.js', { connect }).allowed, true);
  assert.equal(check('https://evil.test/steal', { connect }).allowed, false);
});

test('@connect 的網域也涵蓋它的子網域（跟 Tampermonkey 一致）', () => {
  const connect = ['example.com'];

  assert.equal(check('https://example.com/x', { connect }).allowed, true);
  assert.equal(check('https://api.example.com/x', { connect }).allowed, true);
  assert.equal(check('https://deep.api.example.com/x', { connect }).allowed, true);
  assert.equal(check('https://notexample.com/x', { connect }).allowed, false, '字尾像不算');
  assert.equal(check('https://example.com.evil.test/x', { connect }).allowed, false);
});

test('@connect *.example.com 的寫法也吃得下', () => {
  const connect = ['*.example.com'];

  assert.equal(check('https://api.example.com/x', { connect }).allowed, true);
  assert.equal(check('https://example.com/x', { connect }).allowed, true);
  assert.equal(check('https://evil.test/x', { connect }).allowed, false);
});

test('@connect self 指的是這個站自己', () => {
  const connect = ['self'];

  assert.equal(check('https://shop.example.com/x', { connect }).allowed, true);
  assert.equal(check('https://api.example.com/x', { connect }).allowed, false);
});

test('⛔ @connect * 一律拒絕，並說明要列出具體主機', () => {
  const result = check('https://api.example.com/x', { connect: ['api.example.com'], connectAll: true });

  assert.equal(result.allowed, false);
  assert.ok(/具體主機/.test(result.reason), result.reason);
});

test('大小寫不敏感', () => {
  assert.equal(check('https://API.Example.COM/x', { connect: ['api.example.com'] }).allowed, true);
  assert.equal(check('https://api.example.com/x', { connect: ['API.EXAMPLE.COM'] }).allowed, true);
  assert.equal(check('https://SHOP.example.com/x').allowed, true);
});

test('被擋下來時一定有看得懂的原因，而且提到目標主機', () => {
  const result = check('https://evil.test/x', { connect: ['api.example.com'] });

  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('evil.test'), result.reason);
  assert.ok(result.reason.includes('@connect'), result.reason);
});

test('@connect 裡的垃圾值被忽略，不會變成「全部放行」', () => {
  const connect = ['', '   ', null, 42, '*', 'https://api.example.com/path'];

  assert.equal(check('https://evil.test/x', { connect }).allowed, false);
  assert.equal(check('https://api.example.com/x', { connect }).allowed, false, '帶 scheme/path 的寫法不算合法主機');
});

test('connect 不是陣列也不會炸（當成沒宣告）', () => {
  assert.equal(check('https://api.example.com/x', { connect: null }).allowed, false);
  assert.equal(check('https://shop.example.com/x', { connect: 'api.example.com' }).allowed, true);
});

test('siteOrigin 壞掉時不當機，而且不放行（fail closed）', () => {
  assert.equal(check('https://shop.example.com/x', { siteOrigin: '不是網址' }).allowed, false);
  assert.equal(check('https://shop.example.com/x', { siteOrigin: null }).allowed, false);
});
