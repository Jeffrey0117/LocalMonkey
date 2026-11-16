'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { rawRequest } = require('../support/http.js');

async function arrange(t, scripts) {
  const app = await startApp();
  t.after(() => app.close());
  const seeded = seedSite(app.store, { targetOrigin: 'http://127.0.0.1:1', scripts });
  return { app, ...seeded };
}

test('GET /__lm/script/<id>.js 回腳本原文，包在 try/catch 裡', async (t) => {
  const code = "document.querySelector('h1').textContent = 'LocalMonkey';";
  const { app, scripts } = await arrange(t, [{ name: '換標題', code }]);

  const response = await rawRequest({ port: app.port, path: `/__lm/script/${scripts[0].id}.js` });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/javascript/);
  assert.match(response.headers['content-type'], /charset=utf-8/);
  assert.equal(response.headers['cache-control'], 'no-cache');
  assert.ok(response.text.includes(code), '要有原文');
  assert.ok(response.text.includes('try'));
  assert.ok(response.text.includes('[LocalMonkey] 換標題 執行失敗'));
});

test('腳本被停用 → 404', async (t) => {
  const { app, scripts } = await arrange(t, [{ name: '關掉的', code: 'x', enabled: 0 }]);

  const response = await rawRequest({ port: app.port, path: `/__lm/script/${scripts[0].id}.js` });
  assert.equal(response.status, 404);
});

test('腳本不存在 → 404', async (t) => {
  const { app } = await arrange(t, []);

  const response = await rawRequest({ port: app.port, path: '/__lm/script/scr_deadbeef.js' });
  assert.equal(response.status, 404);
});

test('沒有 .js 結尾 → 404（不要變成任意 id 探測）', async (t) => {
  const { app, scripts } = await arrange(t, [{ name: 'a', code: 'x' }]);

  const response = await rawRequest({ port: app.port, path: `/__lm/script/${scripts[0].id}` });
  assert.equal(response.status, 404);
});

test('路徑穿越不會讀到別的東西', async (t) => {
  const { app } = await arrange(t, []);

  for (const path of ['/__lm/script/..%2f..%2fpackage.json', '/__lm/script/%2e%2e%2f.env.js']) {
    const response = await rawRequest({ port: app.port, path });
    assert.equal(response.status, 404, `${path} 應該 404`);
  }
});

test('改完腳本立刻生效（no-cache 而且讀的是當下的 DB 內容）', async (t) => {
  const { app, scripts } = await arrange(t, [{ name: 'a', code: 'const v = 1;' }]);
  const url = `/__lm/script/${scripts[0].id}.js`;

  const before = await rawRequest({ port: app.port, path: url });
  assert.ok(before.text.includes('const v = 1;'));

  app.store.scripts.update(scripts[0].id, { code: 'const v = 2;' });

  const after = await rawRequest({ port: app.port, path: url });
  assert.ok(after.text.includes('const v = 2;'));
});

test('腳本投遞不需要後台 token（瀏覽器會匿名載它）', async (t) => {
  const { app, scripts } = await arrange(t, [{ name: 'a', code: 'x' }]);

  const response = await rawRequest({
    port: app.port,
    path: `/__lm/script/${scripts[0].id}.js`,
    headers: { cookie: '' },
  });
  assert.equal(response.status, 200);
});

test('一支壞腳本不會把整頁弄掛：送出來的是 try/catch 包好的合法 JS', async (t) => {
  const { app, scripts } = await arrange(t, [
    { name: '壞的', code: 'throw new Error("boom")' },
  ]);

  const response = await rawRequest({ port: app.port, path: `/__lm/script/${scripts[0].id}.js` });
  assert.doesNotThrow(() => new (require('node:vm').Script)(response.text));
});
