'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startApp, adminJson } = require('../support/app.js');
const { rawRequest } = require('../support/http.js');
const { parseUserscript } = require('../../src/userscript/parse.js');

/**
 * `GET /s/<token>/<slug>.user.js` —— 投遞給 Tampermonkey（SPEC-console §8）。
 *
 * 這條路的兩個失敗模式都是「靜默」的：content-type 不對 → 不觸發安裝；
 * @updateURL 沒改寫 → 繼續去腳本原本寫的地方更新。所以兩條都要有測試。
 */

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'real-userscripts');

const REAL_SCRIPTS = [
  'ig-comment-scraper',
  'ig-dm-sender',
  'ig-helper',
  'threads-helper',
  'xpost-card',
  'peekly',
  'revid-subs',
];

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.user.js`), 'utf8');
}

const SIMPLE = [
  '// ==UserScript==',
  '// @name        投遞測試',
  '// @version     1.2.3',
  '// @match       https://example.test/*',
  '// ==/UserScript==',
  "document.title = 'x';",
].join('\n');

async function arrange(t, options = {}) {
  const app = await startApp(options);
  t.after(() => app.close());

  const api = {
    post: (pathname, body) =>
      adminJson(app.base, app.adminToken, pathname, { method: 'POST', body: JSON.stringify(body) }),
    put: (pathname, body) =>
      adminJson(app.base, app.adminToken, pathname, { method: 'PUT', body: JSON.stringify(body) }),
    get: (pathname) => adminJson(app.base, app.adminToken, pathname),
  };

  /** 部署一支腳本，回它的 script 物件（含 delivery_token 與 deliveryUrl） */
  api.deploy = async (source) => (await api.post('/admin/api/scripts', { source })).body.script;

  return { app, ...api };
}

function deliveryPath(script) {
  return new URL(script.deliveryUrl).pathname;
}

/* ------------------------------ 正常情況 ------------------------------ */

test('⛔ content-type 一定要是 text/javascript（text/plain 不會觸發 Tampermonkey 安裝）', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await rawRequest({ port: app.port, path: deliveryPath(script) });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/javascript/);
  assert.match(response.headers['content-type'], /charset=utf-8/);
});

test('安裝網址的形狀是 /s/<64 hex>/<slug>.user.js', async (t) => {
  const { deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  assert.match(deliveryPath(script), /^\/s\/[0-9a-f]{64}\/[a-z0-9-]+\.user\.js$/);
});

test('投遞的內容就是 source（含 header），而且不需要後台 token', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await rawRequest({
    port: app.port,
    path: deliveryPath(script),
    headers: { cookie: '' },
  });

  assert.equal(response.status, 200);
  assert.ok(response.text.includes('// ==UserScript=='));
  assert.ok(response.text.includes("document.title = 'x';"));
});

test('帶 ETag 與 Last-Modified', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await rawRequest({ port: app.port, path: deliveryPath(script) });

  assert.match(response.headers.etag, /^"[0-9a-f]{64}"$/);
  assert.ok(response.headers['last-modified'], '要有 Last-Modified');
  assert.equal(response.headers['cache-control'], 'no-cache');
});

test('⭐ If-None-Match 命中 → 304，而且沒有 body', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const first = await rawRequest({ port: app.port, path: deliveryPath(script) });
  const second = await rawRequest({
    port: app.port,
    path: deliveryPath(script),
    headers: { 'if-none-match': first.headers.etag },
  });

  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0, '304 不該帶 body');
  assert.equal(second.headers.etag, first.headers.etag);
});

test('If-None-Match 對不上（內容改過了）→ 200 加新內容', async (t) => {
  const { app, deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const first = await rawRequest({ port: app.port, path: deliveryPath(script) });
  await put(`/admin/api/scripts/${script.id}`, { source: SIMPLE.replace('1.2.3', '1.2.4') });

  const second = await rawRequest({
    port: app.port,
    path: deliveryPath(script),
    headers: { 'if-none-match': first.headers.etag },
  });

  assert.equal(second.status, 200);
  assert.ok(second.text.includes('1.2.4'));
});

/* --------------------------- header 改寫 --------------------------- */

test('⭐ 投遞出去的內容裡，@updateURL / @downloadURL 已經指向本端點', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(fixture('ig-helper'));

  const response = await rawRequest({ port: app.port, path: deliveryPath(script) });
  const parsed = parseUserscript(response.text);

  assert.equal(
    response.text.includes('http://localhost:8001/scripts/ig-helper.user.js'),
    false,
    '舊的更新網址還在 → Tampermonkey 會繼續去 localhost:8001 更新，等於白做',
  );
  assert.ok(parsed.updateUrl.endsWith(deliveryPath(script)));
  assert.ok(parsed.downloadUrl.endsWith(deliveryPath(script)));
});

test('⭐ 原本沒有這兩個 key → 補上去', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(fixture('peekly'));

  const response = await rawRequest({ port: app.port, path: deliveryPath(script) });
  const parsed = parseUserscript(response.text);

  assert.ok(parsed.updateUrl);
  assert.ok(parsed.downloadUrl);
});

test('⭐ 改寫只動投遞出去的那份，資料庫裡的 source 不變', async (t) => {
  const { app, deploy, get } = await arrange(t);
  const original = fixture('ig-helper');
  const script = await deploy(original);

  await rawRequest({ port: app.port, path: deliveryPath(script) });

  const stored = (await get(`/admin/api/scripts/${script.id}`)).body.script;
  assert.equal(stored.source, original, '資料庫裡要是使用者寫的那份');
  assert.ok(stored.source.includes('http://localhost:8001/scripts/ig-helper.user.js'));
});

test('⭐ 絕對網址用請求的 Host 組（從區網 IP 或 tunnel 網域裝都要對）', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const hosts = ['127.0.0.1:30600', '192.168.1.50:30600', 'monkey.example.com'];
  const seen = [];

  for (const host of hosts) {
    const response = await rawRequest({
      port: app.port,
      path: deliveryPath(script),
      headers: { host },
    });

    const parsed = parseUserscript(response.text);
    seen.push(parsed.updateUrl);
    assert.ok(parsed.updateUrl.startsWith(`http://${host}/s/`), `${host} → ${parsed.updateUrl}`);
  }

  assert.equal(new Set(seen).size, hosts.length, '每個 Host 要給對應的網址');
});

test('x-forwarded-proto 會被採用（tunnel 後面是 https）', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await rawRequest({
    port: app.port,
    path: deliveryPath(script),
    headers: { host: 'monkey.example.com', 'x-forwarded-proto': 'https' },
  });

  assert.ok(parseUserscript(response.text).updateUrl.startsWith('https://monkey.example.com/s/'));
});

/* ------------------------------ 404 ------------------------------ */

test('⭐ 錯 token / 不存在的 token / 停用的腳本 → 全部 404，而且回應一模一樣', async (t) => {
  const { app, deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const disabled = await deploy(SIMPLE.replace('投遞測試', '停用的'));
  await put(`/admin/api/scripts/${disabled.id}`, { enabled: false });

  const responses = [];
  for (const path of [
    '/s/not-hex/x.user.js',
    `/s/${'a'.repeat(64)}/x.user.js`,
    deliveryPath(disabled),
  ]) {
    responses.push(await rawRequest({ port: app.port, path }));
  }

  for (const response of responses) {
    assert.equal(response.status, 404);
  }

  assert.equal(
    new Set(responses.map((response) => response.text)).size,
    1,
    '回應內容不能洩漏「這個 token 存在但腳本停用了」',
  );

  // 對照：啟用中的那支是 200
  assert.equal((await rawRequest({ port: app.port, path: deliveryPath(script) })).status, 200);
});

test('檔名不是 .user.js → 404（保持端點契約乾淨）', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const wrong = deliveryPath(script).replace('.user.js', '.js');
  assert.equal((await rawRequest({ port: app.port, path: wrong })).status, 404);
});

test('路徑穿越拿不到別的東西', async (t) => {
  const { app } = await arrange(t);

  for (const path of ['/s/..%2f..%2fpackage.json', '/s/', '/s/x/y/z.user.js']) {
    const response = await rawRequest({ port: app.port, path });
    assert.equal(response.status, 404, path);
  }
});

/* ------------------------------ 版本 ------------------------------ */

test('⭐ 版本沒變 → versionBumped: false（Tampermonkey 不會更新到這一版）', async (t) => {
  const { deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const saved = await put(`/admin/api/scripts/${script.id}`, {
    source: SIMPLE.replace("document.title = 'x';", "document.title = 'y';"),
  });

  assert.equal(saved.body.versionBumped, false);
  assert.equal(saved.body.version, '1.2.3');
  assert.equal(saved.body.previousVersion, '1.2.3');
});

test('版本往上 → versionBumped: true', async (t) => {
  const { deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const saved = await put(`/admin/api/scripts/${script.id}`, {
    source: SIMPLE.replace('1.2.3', '1.3.0'),
  });

  assert.equal(saved.body.versionBumped, true);
  assert.equal(saved.body.version, '1.3.0');
});

test('⭐ bumpVersion: true → 伺服器把 1.2.3 改成 1.2.4 再存', async (t) => {
  const { app, deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const saved = await put(`/admin/api/scripts/${script.id}`, {
    source: SIMPLE,
    bumpVersion: true,
  });

  assert.equal(saved.body.versionBumped, true);
  assert.equal(saved.body.version, '1.2.4');
  assert.ok(saved.body.script.source.includes('1.2.4'), '回傳的 source 要是改過的那份');

  const delivered = await rawRequest({ port: app.port, path: deliveryPath(script) });
  assert.ok(parseUserscript(delivered.text).version === '1.2.4');
});

test('bumpVersion: true 對沒有 @version 的腳本 → 補 1.0.0', async (t) => {
  const { deploy, put } = await arrange(t);
  const source = ['// ==UserScript==', '// @name 沒版本號', '// @match https://a.test/*', '// ==/UserScript==', 'x'].join('\n');
  const script = await deploy(source);

  assert.equal(script.version, null);

  const saved = await put(`/admin/api/scripts/${script.id}`, { source, bumpVersion: true });

  assert.equal(saved.body.version, '1.0.0');
  assert.equal(saved.body.versionBumped, true);
});

test('bumpVersion 不是布林 → 400', async (t) => {
  const { deploy, put } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await put(`/admin/api/scripts/${script.id}`, { source: SIMPLE, bumpVersion: 'yes' });
  assert.equal(response.status, 400);
});

/* ------------------------------ token 輪替 ------------------------------ */

test('⭐ rotate 之後舊網址 404、新網址 200', async (t) => {
  const { app, deploy, post } = await arrange(t);
  const script = await deploy(SIMPLE);
  const oldPath = deliveryPath(script);

  assert.equal((await rawRequest({ port: app.port, path: oldPath })).status, 200);

  const rotated = await post(`/admin/api/scripts/${script.id}/delivery-token/rotate`, {});
  const newPath = deliveryPath(rotated.body.script);

  assert.equal(rotated.status, 200);
  assert.notEqual(newPath, oldPath);
  assert.equal((await rawRequest({ port: app.port, path: oldPath })).status, 404, '舊網址要失效');
  assert.equal((await rawRequest({ port: app.port, path: newPath })).status, 200);
});

test('rotate 不存在的腳本 → 404', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/scripts/scr_ghost/delivery-token/rotate', {});
  assert.equal(response.status, 404);
});

test('rotate 要 token（這是後台 API）', async (t) => {
  const { app, deploy } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await fetch(`${app.base}/admin/api/scripts/${script.id}/delivery-token/rotate`, {
    method: 'POST',
  });

  assert.equal(response.status, 401);
  await response.text();
});

/* ------------------------------ 速率限制 ------------------------------ */

test('同一個 token 打太頻繁 → 429', async (t) => {
  const { app, deploy } = await arrange(t, { config: { delivery: { rateLimit: 2, rateWindowMs: 60_000 } } });
  const script = await deploy(SIMPLE);
  const path = deliveryPath(script);

  assert.equal((await rawRequest({ port: app.port, path })).status, 200);
  assert.equal((await rawRequest({ port: app.port, path })).status, 200);

  const blocked = await rawRequest({ port: app.port, path });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

/* ---------------------- 七支真實腳本都投遞得出去 ---------------------- */

test('⭐ 七支真實腳本都部署得起來，而且投遞出去的內容裝得起來', async (t) => {
  const { app, deploy } = await arrange(t);

  for (const name of REAL_SCRIPTS) {
    const source = fixture(name);
    const script = await deploy(source);

    const response = await rawRequest({ port: app.port, path: deliveryPath(script) });
    assert.equal(response.status, 200, `${name} → HTTP ${response.status}`);
    assert.match(response.headers['content-type'], /^text\/javascript/, name);

    const parsed = parseUserscript(response.text);
    assert.equal(parsed.hasMetadataBlock, true, name);
    assert.ok(parsed.updateUrl.includes('/s/'), `${name} 的 @updateURL 沒被改寫`);
    assert.ok(parsed.name.length > 0, name);
  }
});

test('⭐ revid-subs：代理模式配不起來，但投遞模式完全正常', async (t) => {
  const { app, post } = await arrange(t);

  const deployed = await post('/admin/api/scripts', { source: fixture('revid-subs') });

  assert.equal(deployed.status, 201);
  assert.equal(deployed.body.targets[0].proxyable, 'rejected', '反向代理指不到「全世界」');
  assert.equal(deployed.body.targets[0].deliverable, true);
  assert.deepEqual(deployed.body.script.sites, [], '沒有站台可以掛');

  // 但投遞模式照樣給得出來 —— 這就是加這個端點的理由
  const response = await rawRequest({
    port: app.port,
    path: new URL(deployed.body.script.deliveryUrl).pathname,
  });

  assert.equal(response.status, 200);
  assert.ok(response.text.includes('ReVid Subtitles'));
  assert.equal(parseUserscript(response.text).targets[0].pattern, '*://*/*');
});

test('GET /scripts/:id 帶得出 deliveryUrl', async (t) => {
  const { deploy, get } = await arrange(t);
  const script = await deploy(SIMPLE);

  const response = await get(`/admin/api/scripts/${script.id}`);

  assert.ok(response.body.script.deliveryUrl.includes('/s/'));
  assert.match(response.body.script.delivery_token, /^[0-9a-f]{64}$/);
});
