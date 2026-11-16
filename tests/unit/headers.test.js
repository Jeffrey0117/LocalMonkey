'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpstreamHeaders,
  filterResponseHeaders,
  DROPPED_REQUEST_HEADERS,
  DROPPED_RESPONSE_HEADERS,
} = require('../../src/lib/headers.js');

test('請求：hop-by-hop 與會打壞上游的 header 被移除', () => {
  const incoming = {
    host: 'localhost:30600',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    'proxy-authorization': 'Basic xxx',
    'proxy-connection': 'keep-alive',
    te: 'trailers',
    trailer: 'Expires',
    'content-length': '123',
    cookie: 'a=1',
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html',
    'accept-language': 'zh-TW',
    'content-type': 'application/json',
  };

  const out = buildUpstreamHeaders(incoming, { host: 'www.example.com' });

  for (const name of DROPPED_REQUEST_HEADERS) {
    if (name === 'host') continue;
    assert.equal(name in out, false, `${name} 應該被移除`);
  }
  assert.equal(out.host, 'www.example.com', 'host 要改成上游 host');
  assert.equal(out.cookie, 'a=1');
  assert.equal(out['user-agent'], 'Mozilla/5.0');
  assert.equal(out.accept, 'text/html');
  assert.equal(out['accept-language'], 'zh-TW');
  assert.equal(out['content-type'], 'application/json');
});

test('請求：不自己加 accept-encoding（讓 Node fetch 自己處理解壓）', () => {
  const out = buildUpstreamHeaders({ 'accept-encoding': 'br, gzip' }, { host: 'x.test' });
  assert.equal('accept-encoding' in out, false);
});

test('請求：原物件不被 mutate', () => {
  const incoming = Object.freeze({ host: 'a', connection: 'keep-alive' });
  const out = buildUpstreamHeaders(incoming, { host: 'b' });
  assert.equal(incoming.host, 'a');
  assert.equal(out.host, 'b');
});

test('請求：陣列型 header 值被攤平成逗號字串', () => {
  const out = buildUpstreamHeaders({ 'x-multi': ['a', 'b'] }, { host: 'x.test' });
  assert.equal(out['x-multi'], 'a, b');
});

test('請求：大小寫不同的 header 名稱也要被過濾掉', () => {
  const out = buildUpstreamHeaders({ Connection: 'keep-alive', Host: 'old' }, { host: 'new' });
  assert.equal(out.connection, undefined);
  assert.equal(out.Connection, undefined);
  assert.equal(out.host, 'new');
});

test('回應：CSP / X-Frame-Options / content-encoding 等被拿掉', () => {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'",
    'content-security-policy-report-only': "default-src 'none'",
    'x-frame-options': 'DENY',
    'content-encoding': 'gzip',
    'content-length': '999',
    'strict-transport-security': 'max-age=31536000',
    'report-to': 'group',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'x-custom': 'keep-me',
    etag: 'W/"abc"',
  });

  const pairs = filterResponseHeaders(headers);
  const names = pairs.map(([name]) => name);

  for (const dropped of DROPPED_RESPONSE_HEADERS) {
    assert.equal(names.includes(dropped), false, `${dropped} 應該被移除`);
  }
  assert.equal(names.includes('x-custom'), true);
  assert.equal(names.includes('etag'), true);
  assert.deepEqual(
    pairs.find(([name]) => name === 'content-type'),
    ['content-type', 'text/html; charset=utf-8'],
  );
});

test('回應：set-cookie 不由這裡處理（要逐條改寫，交給 cookies 模組）', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'a=1');
  headers.append('set-cookie', 'b=2');
  headers.set('x-ok', '1');

  const names = filterResponseHeaders(headers).map(([name]) => name);
  assert.equal(names.includes('set-cookie'), false);
  assert.equal(names.includes('x-ok'), true);
});

test('回應：transfer-encoding 被拿掉（解壓後的 body 與它不符）', () => {
  const headers = new Headers({ 'transfer-encoding': 'chunked' });
  assert.deepEqual(filterResponseHeaders(headers), []);
});
