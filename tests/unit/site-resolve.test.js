'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveSiteIdFromHeaders, siteIdFromReferer } = require('../../src/lib/site-resolve.js');

test('cookie 優先於 referer', () => {
  const siteId = resolveSiteIdFromHeaders({
    cookie: 'lm_site=from-cookie',
    referer: 'http://127.0.0.1:30600/p/from-referer/page',
  });
  assert.equal(siteId, 'from-cookie');
});

test('沒有 cookie 時退回 referer', () => {
  assert.equal(
    resolveSiteIdFromHeaders({ referer: 'http://127.0.0.1:30600/p/demo/page?x=1' }),
    'demo',
  );
});

test('兩個都沒有 → null（呼叫端要回 404 而不是 502）', () => {
  assert.equal(resolveSiteIdFromHeaders({}), null);
  assert.equal(resolveSiteIdFromHeaders({ cookie: 'other=1' }), null);
  assert.equal(resolveSiteIdFromHeaders({ referer: 'http://127.0.0.1:30600/admin' }), null);
});

test('cookie 裡的 slug 格式不合就不信它', () => {
  assert.equal(resolveSiteIdFromHeaders({ cookie: 'lm_site=../../etc/passwd' }), null);
  assert.equal(resolveSiteIdFromHeaders({ cookie: 'lm_site=UPPER' }), null);
  assert.equal(resolveSiteIdFromHeaders({ cookie: 'lm_site=' }), null);
});

test('cookie 不合法但 referer 合法時，用 referer', () => {
  const siteId = resolveSiteIdFromHeaders({
    cookie: 'lm_site=BAD!',
    referer: 'http://127.0.0.1:30600/p/demo/',
  });
  assert.equal(siteId, 'demo');
});

test('siteIdFromReferer 認得各種形狀', () => {
  assert.equal(siteIdFromReferer('http://127.0.0.1:30600/p/demo/'), 'demo');
  assert.equal(siteIdFromReferer('http://127.0.0.1:30600/p/demo'), 'demo');
  assert.equal(siteIdFromReferer('http://127.0.0.1:30600/p/demo/deep/path?q=1#h'), 'demo');
  assert.equal(siteIdFromReferer('/p/demo/x'), 'demo');
  assert.equal(siteIdFromReferer('http://127.0.0.1:30600/px/demo/'), null);
  assert.equal(siteIdFromReferer('http://127.0.0.1:30600/'), null);
  assert.equal(siteIdFromReferer(undefined), null);
});
