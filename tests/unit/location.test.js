'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteLocation } = require('../../src/lib/location.js');

const site = { id: 'demo', target_origin: 'https://www.example.com' };

test('同源的絕對網址改寫成代理路徑，query 與 hash 保留', () => {
  assert.equal(
    rewriteLocation('https://www.example.com/a/b?x=1#frag', site),
    '/p/demo/a/b?x=1#frag',
  );
  assert.equal(rewriteLocation('https://www.example.com', site), '/p/demo/');
  assert.equal(rewriteLocation('https://www.example.com/', site), '/p/demo/');
});

test('不同網域原樣保留', () => {
  const other = 'https://accounts.google.com/signin?next=1';
  assert.equal(rewriteLocation(other, site), other);
});

test('同網域但不同 scheme / port 視為不同 origin，原樣保留', () => {
  assert.equal(rewriteLocation('http://www.example.com/a', site), 'http://www.example.com/a');
  assert.equal(
    rewriteLocation('https://www.example.com:8443/a', site),
    'https://www.example.com:8443/a',
  );
});

test('根相對路徑也掛上代理前綴（不然會打到 fallback 靠 cookie 猜）', () => {
  assert.equal(rewriteLocation('/login', site), '/p/demo/login');
  assert.equal(rewriteLocation('/', site), '/p/demo/');
  assert.equal(rewriteLocation('/a?b=1', site), '/p/demo/a?b=1');
});

test('protocol-relative 視為跨域，不動', () => {
  assert.equal(rewriteLocation('//cdn.test/x', site), '//cdn.test/x');
});

test('相對路徑不動（瀏覽器會用當前代理路徑解析）', () => {
  assert.equal(rewriteLocation('next.html', site), 'next.html');
  assert.equal(rewriteLocation('../up', site), '../up');
});

test('已經是代理路徑的不重複加前綴', () => {
  assert.equal(rewriteLocation('/p/demo/a', site), '/p/demo/a');
});

test('空值或壞網址不會爆', () => {
  assert.equal(rewriteLocation('', site), '');
  assert.equal(rewriteLocation(undefined, site), undefined);
  assert.equal(rewriteLocation('http://[bad', site), 'http://[bad');
});
