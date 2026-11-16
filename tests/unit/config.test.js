'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../../src/config.js');

test('預設值照規格：port 30600、只綁 127.0.0.1、不放行私網', () => {
  const config = loadConfig({});
  assert.equal(config.port, 30600);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowPrivate, false);
  assert.equal(config.adminToken, null);
  assert.equal(path.isAbsolute(config.dataDir), true);
  assert.equal(path.basename(config.dataDir), 'data');
});

test('PORT / HOST 可覆蓋', () => {
  const config = loadConfig({ PORT: '41234', HOST: '0.0.0.0' });
  assert.equal(config.port, 41234);
  assert.equal(config.host, '0.0.0.0');
});

test('壞的 PORT 退回預設而不是變成 NaN', () => {
  assert.equal(loadConfig({ PORT: 'abc' }).port, 30600);
  assert.equal(loadConfig({ PORT: '' }).port, 30600);
  assert.equal(loadConfig({ PORT: '99999' }).port, 30600);
  assert.equal(loadConfig({ PORT: '0' }).port, 0, 'port 0 是合法的（測試用）');
});

test('LOCALMONKEY_ALLOW_PRIVATE 只有 1 才算開', () => {
  assert.equal(loadConfig({ LOCALMONKEY_ALLOW_PRIVATE: '1' }).allowPrivate, true);
  assert.equal(loadConfig({ LOCALMONKEY_ALLOW_PRIVATE: '0' }).allowPrivate, false);
  assert.equal(loadConfig({ LOCALMONKEY_ALLOW_PRIVATE: 'true' }).allowPrivate, false);
});

test('空白的 admin token 等於沒設（不准變成可通過的 token）', () => {
  assert.equal(loadConfig({ LOCALMONKEY_ADMIN_TOKEN: '   ' }).adminToken, null);
  assert.equal(loadConfig({ LOCALMONKEY_ADMIN_TOKEN: '' }).adminToken, null);
  assert.equal(loadConfig({ LOCALMONKEY_ADMIN_TOKEN: ' abc ' }).adminToken, 'abc');
});

test('dataDir 可用 env 覆蓋', () => {
  const config = loadConfig({ LOCALMONKEY_DATA_DIR: path.join('C:', 'tmp', 'lm') });
  assert.equal(config.dataDir, path.resolve(path.join('C:', 'tmp', 'lm')));
});

test('上游 timeout 有預設且可覆蓋', () => {
  assert.equal(loadConfig({}).upstreamTimeoutMs, 20000);
  assert.equal(loadConfig({ LOCALMONKEY_UPSTREAM_TIMEOUT_MS: '5000' }).upstreamTimeoutMs, 5000);
  assert.equal(loadConfig({ LOCALMONKEY_UPSTREAM_TIMEOUT_MS: 'x' }).upstreamTimeoutMs, 20000);
});

test('請求 body 上限有預設', () => {
  assert.ok(loadConfig({}).maxRequestBodyBytes >= 1024 * 1024);
  assert.equal(loadConfig({ LOCALMONKEY_MAX_BODY_BYTES: '2048' }).maxRequestBodyBytes, 2048);
});

test('LOCALMONKEY_GM_ALLOW_HOSTS：逗號分隔，預設空的', () => {
  assert.deepEqual(loadConfig({}).gmXhr.allowHosts, [], '預設什麼都不放行');

  assert.deepEqual(
    loadConfig({ LOCALMONKEY_GM_ALLOW_HOSTS: 'localhost:8001, 127.0.0.1:8001' }).gmXhr.allowHosts,
    ['localhost:8001', '127.0.0.1:8001'],
  );
});

test('GM_xmlhttpRequest 的上限有預設值，env 可以蓋', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.gmXhr.timeoutMs, 30_000);
  assert.equal(defaults.gmXhr.maxResponseBytes, 10 * 1024 * 1024);
  assert.equal(defaults.gmXhr.rateLimit, 60);

  const custom = loadConfig({ LOCALMONKEY_GM_XHR_RATE: '5', LOCALMONKEY_GM_XHR_TIMEOUT_MS: '1000' });
  assert.equal(custom.gmXhr.rateLimit, 5);
  assert.equal(custom.gmXhr.timeoutMs, 1000);
});

test('抓 @require 的上限也有預設值', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.assetTimeoutMs, 15_000);
  assert.equal(defaults.assetMaxBytes, 5 * 1024 * 1024);
});
