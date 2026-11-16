'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

async function arrange(t, appOptions = {}) {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream saw ${req.url}`);
  });
  const app = await startApp(appOptions);

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  seedSite(app.store, { targetOrigin: upstream.origin });
  return { app, upstream };
}

test('⛔ /p/<site>//別的網域/ 不可以變成開放代理', async (t) => {
  const { app, upstream } = await arrange(t);

  const response = await rawRequest({ port: app.port, path: '/p/demo//evil.test/x' });

  assert.equal(response.status, 200, `被導去別的地方了（${response.status}）`);
  assert.equal(upstream.received.length, 1, '請求必須還是落在原本的上游');
  assert.equal(upstream.lastRequest().url, '//evil.test/x');
});

test('⛔ 根路徑 fallback 也不能被 // 劫持', async (t) => {
  const { app, upstream } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '//evil.test/x',
    headers: { cookie: 'lm_site=demo' },
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.lastRequest().url, '//evil.test/x');
});

test('⛔ 不放行私網時，也不能用 // 繞過 SSRF 檢查打內網', async (t) => {
  // 這個網站指向公開網域（過得了 SSRF 檢查），攻擊者再用 // 把真正的目標換成內網位址
  const app = await startApp({ config: { allowPrivate: false } });
  t.after(() => app.close());
  seedSite(app.store, { targetOrigin: 'https://example.com' });

  const response = await rawRequest({ port: app.port, path: '/p/demo//192.168.1.1/admin' });

  // 只要主機沒被換掉，這個請求就是打 example.com 的 //192.168.1.1/admin（404 之類），
  // 絕對不會是「連得上 192.168.1.1」。
  assert.notEqual(response.status, 200);
  assert.equal(
    response.text.includes('上游網站沒有回應') && response.text.includes('192.168.1.1'),
    false,
    '錯誤頁不該顯示它真的去連了內網位址',
  );
});

test('腳本 id 不可預測（64-bit 隨機），而且不會洩漏別的腳本', async (t) => {
  const { app } = await arrange(t);
  const first = app.store.scripts.create('demo', { name: 'a', code: 'x' });
  const second = app.store.scripts.create('demo', { name: 'b', code: 'y' });

  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^scr_[0-9a-f]{16}$/);

  const guess = await rawRequest({ port: app.port, path: '/__lm/script/scr_0000000000000000.js' });
  assert.equal(guess.status, 404);
});

test('代理頁面不會把後台 token 洩漏出去（lm_admin 的 Path 是 /admin）', async (t) => {
  const { app } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/p/demo/',
    headers: { cookie: `lm_admin=${app.adminToken}; lm_site=demo` },
  });

  // 瀏覽器本來就不會把 Path=/admin 的 cookie 送到 /p/...，
  // 但萬一有人手動帶了，也不可以出現在回應裡。
  assert.equal(response.text.includes(app.adminToken), false);
});

test('錯誤頁會對使用者輸入做 HTML escape（反射型 XSS）', async (t) => {
  const { app } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/p/x/',
    headers: { cookie: 'lm_site=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E' },
  });

  assert.equal(response.status, 404);
  assert.equal(response.text.includes('<img src=x onerror=alert(1)>'), false);
});
