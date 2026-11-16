'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { start } = require('../../src/index.js');
const { TOKEN_FILENAME } = require('../../src/admin/token.js');
const { rawRequest } = require('../support/http.js');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-start-'));
}

/** `npm start` 真正走的那條路：loadConfig → openDatabase → ensureAdminToken → listen */
async function startServer(t, extraEnv = {}) {
  const dataDir = tempDataDir();
  const started = start({
    PORT: '0',
    HOST: '127.0.0.1',
    LOCALMONKEY_DATA_DIR: dataDir,
    LOCALMONKEY_LOG_LEVEL: 'silent',
    ...extraEnv,
  });

  await new Promise((resolve) => started.server.once('listening', resolve));

  t.after(
    () =>
      new Promise((done) => {
        started.server.close(() => {
          started.db.close();
          done();
        });
      }),
  );

  return { ...started, dataDir, port: started.server.address().port };
}

test('start() 會建立 DB 檔與 token 檔，並真的聽在 port 上', async (t) => {
  const server = await startServer(t);

  assert.ok(fs.existsSync(server.config.databaseFile), 'DB 檔應該被建出來');
  assert.ok(fs.existsSync(path.join(server.dataDir, TOKEN_FILENAME)), 'token 檔應該被建出來');
  assert.equal(server.token.source, 'generated');
  assert.match(server.token.token, /^[0-9a-f]{64}$/);

  const response = await rawRequest({ port: server.port, path: '/admin' });
  assert.equal(response.status, 401, '沒帶 token 就是 401');
});

test('start() 產生的 token 真的可以用', async (t) => {
  const server = await startServer(t);

  const response = await rawRequest({
    port: server.port,
    path: '/admin/api/sites',
    headers: { authorization: `Bearer ${server.token.token}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { sites: [] });
});

test('LOCALMONKEY_ADMIN_TOKEN 有設就用它，而且不寫 token 檔', async (t) => {
  const server = await startServer(t, { LOCALMONKEY_ADMIN_TOKEN: 'env-supplied-token-abcdef' });

  assert.equal(server.token.source, 'env');
  assert.equal(fs.existsSync(path.join(server.dataDir, TOKEN_FILENAME)), false);

  const response = await rawRequest({
    port: server.port,
    path: '/admin/api/sites',
    headers: { authorization: 'Bearer env-supplied-token-abcdef' },
  });
  assert.equal(response.status, 200);
});

test('重啟後 token 不變（讀既有的檔案）', async (t) => {
  const dataDir = tempDataDir();
  const env = {
    PORT: '0',
    HOST: '127.0.0.1',
    LOCALMONKEY_DATA_DIR: dataDir,
    LOCALMONKEY_LOG_LEVEL: 'silent',
  };

  const first = start(env);
  await new Promise((resolve) => first.server.once('listening', resolve));
  await new Promise((done) => first.server.close(() => done()));
  first.db.close();

  const second = start(env);
  await new Promise((resolve) => second.server.once('listening', resolve));
  t.after(
    () =>
      new Promise((done) => {
        second.server.close(() => {
          second.db.close();
          done();
        });
      }),
  );

  assert.equal(second.token.source, 'file');
  assert.equal(second.token.token, first.token.token);
});

test('資料真的寫進 SQLite 檔，重啟後還在', async (t) => {
  const dataDir = tempDataDir();
  const env = {
    PORT: '0',
    HOST: '127.0.0.1',
    LOCALMONKEY_DATA_DIR: dataDir,
    LOCALMONKEY_LOG_LEVEL: 'silent',
  };

  const first = start(env);
  await new Promise((resolve) => first.server.once('listening', resolve));
  first.store.sites.create({
    id: 'persisted',
    name: '存下來的網站',
    target_origin: 'https://example.com',
    enabled: 1,
  });
  await new Promise((done) => first.server.close(() => done()));
  first.db.close();

  const second = start(env);
  await new Promise((resolve) => second.server.once('listening', resolve));
  t.after(
    () =>
      new Promise((done) => {
        second.server.close(() => {
          second.db.close();
          done();
        });
      }),
  );

  assert.equal(second.store.sites.get('persisted').name, '存下來的網站');
});
