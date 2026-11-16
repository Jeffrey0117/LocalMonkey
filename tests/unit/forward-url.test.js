'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildUpstreamUrl } = require('../../src/proxy/forward.js');

const TARGET = 'https://www.example.com';

test('一般路徑與 query 原樣接到 target_origin 後面', () => {
  assert.equal(buildUpstreamUrl(TARGET, '/').href, 'https://www.example.com/');
  assert.equal(buildUpstreamUrl(TARGET, '/a/b').href, 'https://www.example.com/a/b');
  assert.equal(
    buildUpstreamUrl(TARGET, '/search?q=hello%20world&page=2').href,
    'https://www.example.com/search?q=hello%20world&page=2',
  );
  assert.equal(
    buildUpstreamUrl(TARGET, '/%E4%B8%AD%E6%96%87.html').href,
    'https://www.example.com/%E4%B8%AD%E6%96%87.html',
  );
  assert.equal(buildUpstreamUrl(TARGET, '/a+b?c=d%2Be').href, 'https://www.example.com/a+b?c=d%2Be');
  assert.equal(buildUpstreamUrl(TARGET, '/dir/').href, 'https://www.example.com/dir/');
  assert.equal(buildUpstreamUrl(TARGET, '/path?empty=').href, 'https://www.example.com/path?empty=');
});

test('空字串當成根路徑', () => {
  assert.equal(buildUpstreamUrl(TARGET, '').href, 'https://www.example.com/');
  assert.equal(buildUpstreamUrl(TARGET, undefined).href, 'https://www.example.com/');
});

test('⛔ 以 // 開頭的路徑不可以換掉上游主機（不然就是開放代理 + SSRF 繞過）', () => {
  const url = buildUpstreamUrl(TARGET, '//evil.test/x');
  assert.equal(url.origin, TARGET, `被換成 ${url.origin} 了`);
  assert.equal(url.href, 'https://www.example.com//evil.test/x');
});

test('⛔ 反斜線也不行（URL 解析器把 \\ 當成 /）', () => {
  for (const path of ['/\\evil.test/x', '/\\\\evil.test/x', '\\\\evil.test/x']) {
    const url = buildUpstreamUrl(TARGET, path);
    assert.equal(url.origin, TARGET, `${path} 把 origin 換成 ${url.origin}`);
  }
});

test('⛔ 路徑裡夾帶 @ 也不能變成 userinfo 來換主機', () => {
  const url = buildUpstreamUrl(TARGET, '//user@evil.test/x');
  assert.equal(url.origin, TARGET);
});

test('沒有開頭斜線的路徑會補上', () => {
  assert.equal(buildUpstreamUrl(TARGET, 'a/b').href, 'https://www.example.com/a/b');
});

test('target_origin 帶 port 時 port 要留著', () => {
  assert.equal(buildUpstreamUrl('http://127.0.0.1:4100', '/x').href, 'http://127.0.0.1:4100/x');
});
