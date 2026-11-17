'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startApp, adminJson } = require('../support/app.js');

/**
 * 「設定」分頁的資料來源（SPEC-dashboard §2.4）。
 *
 * 刻意是**唯讀**的：這些全部來自環境變數，改了要重啟才生效，
 * 做成輸入框只會給人錯誤期待。所以這支端點只回「目前生效的值」。
 */

async function arrange(t, config = {}) {
  const app = await startApp({
    config: {
      port: 30699,
      host: '127.0.0.1',
      dataDir: path.join('C:', 'tmp', 'lm-data'),
      databaseFile: path.join('C:', 'tmp', 'lm-data', 'localmonkey.db'),
      ...config,
    },
  });
  t.after(() => app.close());

  return {
    settings: async () =>
      (await adminJson(app.base, app.adminToken, '/admin/api/settings')).body.settings,
    app,
  };
}

test('回得出 port / host / 資料庫路徑 / token 檔位置', async (t) => {
  const { settings } = await arrange(t);
  const value = await settings();

  assert.equal(value.port, 30699);
  assert.equal(value.host, '127.0.0.1');
  assert.match(value.databaseFile, /localmonkey\.db$/);
  assert.match(value.adminTokenFile, /admin-token\.txt$/);
  assert.equal(path.dirname(value.adminTokenFile), path.dirname(value.databaseFile));
});

test('⛔ 回路徑可以，但絕對不准回 token 本身', async (t) => {
  const { settings, app } = await arrange(t);
  const value = await settings();

  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(app.adminToken), false, 'token 不准出現在設定裡');
  assert.equal('adminToken' in value, false);
  assert.equal('token' in value, false);
});

test('GM 白名單與 ALLOW_PRIVATE 照舊（既有的資訊列靠它判斷 @connect）', async (t) => {
  const { settings } = await arrange(t, {
    allowPrivate: true,
    gmXhr: { allowHosts: ['127.0.0.1:8001'] },
  });

  const value = await settings();

  assert.equal(value.allowPrivate, true);
  assert.deepEqual(value.gmAllowHosts, ['127.0.0.1:8001']);
});

test('沒設白名單時是空陣列，不是 undefined（UI 要能直接 .length）', async (t) => {
  const { settings } = await arrange(t, { gmXhr: { allowHosts: [] } });
  const value = await settings();

  assert.deepEqual(value.gmAllowHosts, []);
});

test('設定端點一樣要 token', async (t) => {
  const { app } = await arrange(t);

  const response = await fetch(`${app.base}/admin/api/settings`);
  assert.equal(response.status, 401);
});
