'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAllowHosts,
  isAllowedHost,
  looksLoopback,
  isConnectHostCovered,
  blockedConnectHosts,
} = require('../../src/lib/gm-allow-hosts.js');

test('parseAllowHosts：逗號分隔、去空白、轉小寫、去重', () => {
  assert.deepEqual(parseAllowHosts('localhost:8001, 127.0.0.1:8001'), [
    'localhost:8001',
    '127.0.0.1:8001',
  ]);
  assert.deepEqual(parseAllowHosts(' LOCALHOST:8001 '), ['localhost:8001']);
  assert.deepEqual(parseAllowHosts('a:1,a:1'), ['a:1']);
});

test('parseAllowHosts：沒設 / 空字串 → 空清單（預設什麼都不放行）', () => {
  for (const raw of [undefined, null, '', '   ', ',,,', 42]) {
    assert.deepEqual(parseAllowHosts(raw), [], JSON.stringify(raw));
  }
});

test('parseAllowHosts 的結果是凍結的', () => {
  assert.throws(() => parseAllowHosts('a:1').push('b:2'), TypeError);
});

test('isAllowedHost：精確比對，含 port', () => {
  const allow = parseAllowHosts('localhost:8001');

  assert.equal(isAllowedHost(allow, new URL('http://localhost:8001/api')), true);
  assert.equal(isAllowedHost(allow, new URL('https://localhost:8001/api')), true, 'scheme 不影響');
  assert.equal(isAllowedHost(allow, new URL('http://localhost:9000/api')), false, 'port 不同就是不同');
  assert.equal(isAllowedHost(allow, new URL('http://localhost/api')), false, '沒 port 不等於有 port');
  assert.equal(isAllowedHost(allow, new URL('http://127.0.0.1:8001/api')), false, '不做位址推論');
});

test('isAllowedHost：預設（空白名單）一律不放行', () => {
  assert.equal(isAllowedHost([], new URL('http://localhost:8001/')), false);
  assert.equal(isAllowedHost(undefined, new URL('http://localhost:8001/')), false);
});

test('isAllowedHost：不做萬用字元', () => {
  const allow = parseAllowHosts('*.localhost:8001,*');

  assert.equal(isAllowedHost(allow, new URL('http://api.localhost:8001/')), false);
  assert.equal(isAllowedHost(allow, new URL('http://anything:8001/')), false);
});

test('isAllowedHost：大小寫不敏感；非 URL 不會炸', () => {
  const allow = parseAllowHosts('LocalHost:8001');

  assert.equal(isAllowedHost(allow, new URL('http://LOCALHOST:8001/')), true);
  assert.equal(isAllowedHost(allow, 'http://localhost:8001/'), false, '要 URL 物件，字串不算');
  assert.equal(isAllowedHost(allow, null), false);
});

test('looksLoopback：認得出字面上的本機位址', () => {
  for (const host of ['localhost', 'localhost:8001', '127.0.0.1', '127.0.0.1:3000', '127.1.2.3', '0.0.0.0', '::1', 'api.localhost']) {
    assert.equal(looksLoopback(host), true, host);
  }
});

test('looksLoopback：公開主機不要亂報（假警告會讓人不信警告）', () => {
  for (const host of ['example.com', 'api.example.com', 'translate.googleapis.com', 'fbcdn.net', '10.0.0.1', '192.168.1.1']) {
    assert.equal(looksLoopback(host), false, host);
  }
});

test('isConnectHostCovered：@connect 不帶 port，白名單帶 port，比對 hostname', () => {
  const allow = parseAllowHosts('localhost:8001');

  assert.equal(isConnectHostCovered(allow, 'localhost'), true, '宣告 localhost + 白名單有某個 localhost port');
  assert.equal(isConnectHostCovered(allow, '127.0.0.1'), false);
  assert.equal(isConnectHostCovered([], 'localhost'), false);
  assert.equal(isConnectHostCovered(allow, ''), false);
});

test('⭐ blockedConnectHosts：真實案例（@connect localhost、白名單空的）要被點出來', () => {
  assert.deepEqual(blockedConnectHosts(['localhost'], []), ['localhost']);
  assert.deepEqual(blockedConnectHosts(['localhost'], parseAllowHosts('localhost:8001')), []);
});

test('blockedConnectHosts：只點本機位址，公開主機不算', () => {
  const connect = ['translate.googleapis.com', 'pbs.twimg.com', 'fbcdn.net', 'cdninstagram.com', 'localhost'];

  assert.deepEqual(blockedConnectHosts(connect, []), ['localhost'], 'xpost-card 的實際宣告');
  assert.deepEqual(blockedConnectHosts(connect, parseAllowHosts('localhost:8001')), []);
});

test('blockedConnectHosts：輸入亂七八糟也不炸', () => {
  assert.deepEqual(blockedConnectHosts(null, null), []);
  assert.deepEqual(blockedConnectHosts(undefined, []), []);
});
