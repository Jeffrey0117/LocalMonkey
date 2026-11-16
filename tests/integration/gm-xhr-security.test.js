'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { parseUserscript } = require('../../src/userscript/parse.js');

/**
 * `/__lm/gm/xhr` 的七道防護（規格 §4.2）。
 * 這個端點會讓伺服器代替使用者發任意請求 —— 沒鎖好就是開放代理 + SSRF。
 */

const PAGE = '<!doctype html><html><head></head><body>hi</body></html>';

async function arrange(t, { appOptions = {}, apiHandler } = {}) {
  const pageUpstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  const apiUpstream = await startUpstream(
    apiHandler ??
      ((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }),
  );

  const app = await startApp(appOptions);

  t.after(async () => {
    await app.close();
    await apiUpstream.close();
    await pageUpstream.close();
  });

  app.store.sites.create({ id: 'demo', name: 'demo', target_origin: pageUpstream.origin });

  return { app, pageUpstream, apiUpstream };
}

function seedScript(app, { connect = [], grants = ['GM_xmlhttpRequest'], siteIds = ['demo'] } = {}) {
  const source = [
    '// ==UserScript==',
    '// @name 打 API 的腳本',
    '// @match https://demo.test/*',
    ...connect.map((host) => `// @connect ${host}`),
    ...grants.map((grant) => `// @grant ${grant}`),
    '// ==/UserScript==',
    'GM_xmlhttpRequest({ url: "https://api.example.com/x" });',
  ].join('\n');

  const parsed = parseUserscript(source);
  const script = app.store.userscripts.create({
    name: parsed.name,
    source,
    metadata: { ...parsed, requireAssets: [], resourceAssets: [] },
    run_at: parsed.runAt,
  });

  if (siteIds.length > 0) {
    app.store.userscripts.setBindings(
      script.id,
      siteIds.map((siteId) => ({ site_id: siteId, path_glob: '*' })),
    );
  }

  return script;
}

/** 模擬「被代理頁面上的 shim」發出的請求 */
async function callXhr(app, body, { headers = {}, sameOrigin = true } = {}) {
  const response = await fetch(`${app.base}/__lm/gm/xhr`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sameOrigin
        ? {
            'sec-fetch-site': 'same-origin',
            referer: `${app.base}/p/demo/page`,
          }
        : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

/* ------------------------------ 正常情況 ------------------------------ */

test('@connect 有列出來 → 轉發成功，回傳 Tampermonkey 形狀的欄位', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, {
    scriptId: script.id,
    method: 'GET',
    url: `${apiUpstream.origin}/data?q=1`,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 200);
  assert.equal(result.body.statusText, 'OK');
  assert.equal(result.body.finalUrl, `${apiUpstream.origin}/data?q=1`);
  assert.deepEqual(JSON.parse(result.body.responseText), { ok: true, path: '/data?q=1' });
  assert.equal(result.body.headers['content-type'], 'application/json');
  assert.equal(result.body.truncated, false);

  assert.equal(apiUpstream.lastRequest().method, 'GET');
  assert.equal(apiUpstream.lastRequest().url, '/data?q=1');
});

test('POST 會把 data 帶上去', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  await callXhr(app, {
    scriptId: script.id,
    method: 'POST',
    url: `${apiUpstream.origin}/submit`,
    headers: { 'content-type': 'application/json' },
    data: '{"hello":"world"}',
  });

  const received = apiUpstream.lastRequest();
  assert.equal(received.method, 'POST');
  assert.equal(received.body.toString('utf8'), '{"hello":"world"}');
  assert.equal(received.headers['content-type'], 'application/json');
});

test('沒宣告 @connect 時，打站自己的 origin 是可以的', async (t) => {
  const { app, pageUpstream } = await arrange(t);
  const script = seedScript(app, { connect: [] });

  const result = await callXhr(app, {
    scriptId: script.id,
    url: `${pageUpstream.origin}/same-site`,
  });

  assert.equal(result.status, 200);
});

/* --------------------- 防護 1：來源必須對應到啟用中的 site --------------------- */

test('防護1：跨站請求（Sec-Fetch-Site: cross-site）→ 403', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(
    app,
    { scriptId: script.id, url: `${apiUpstream.origin}/x` },
    { headers: { 'sec-fetch-site': 'cross-site' } },
  );

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'cross_site_blocked');
});

test('防護1：Origin 是別的網站 → 403', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(
    app,
    { scriptId: script.id, url: `${apiUpstream.origin}/x` },
    { sameOrigin: false, headers: { origin: 'https://evil.test' } },
  );

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'cross_site_blocked');
});

test('防護1：認不出屬於哪個網站（沒有 Referer 也沒有 cookie）→ 403', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(
    app,
    { scriptId: script.id, url: `${apiUpstream.origin}/x` },
    { sameOrigin: false },
  );

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'unknown_site');
});

test('防護1：網站被停用 → 403', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });
  app.store.sites.update('demo', { enabled: 0 });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'unknown_site');
});

test('防護1：lm_site cookie 也可以當來源（頁面設了 no-referrer 時的退路）', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(
    app,
    { scriptId: script.id, url: `${apiUpstream.origin}/x` },
    { sameOrigin: false, headers: { 'sec-fetch-site': 'same-origin', cookie: 'lm_site=demo' } },
  );

  assert.equal(result.status, 200);
});

test('腳本不存在 / 已停用 / 沒掛在這個站 → 403（不能借別的站的 @connect）', async (t) => {
  const { app, apiUpstream } = await arrange(t);

  const ghost = await callXhr(app, { scriptId: 'scr_ghost', url: `${apiUpstream.origin}/x` });
  assert.equal(ghost.status, 403);
  assert.equal(ghost.body.error, 'unknown_script');

  const disabled = seedScript(app, { connect: ['127.0.0.1'] });
  app.store.userscripts.update(disabled.id, { enabled: 0 });
  const off = await callXhr(app, { scriptId: disabled.id, url: `${apiUpstream.origin}/x` });
  assert.equal(off.status, 403);
  assert.equal(off.body.error, 'unknown_script');

  app.store.sites.create({ id: 'other', name: 'other', target_origin: 'https://other.test' });
  const elsewhere = seedScript(app, { connect: ['127.0.0.1'], siteIds: ['other'] });
  const wrongSite = await callXhr(app, { scriptId: elsewhere.id, url: `${apiUpstream.origin}/x` });
  assert.equal(wrongSite.status, 403);
  assert.equal(wrongSite.body.error, 'script_not_on_site');
});

test('腳本沒宣告 @grant GM_xmlhttpRequest → 403（不給沒要求的能力）', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'], grants: ['GM_setValue'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'grant_required');
});

/* --------------------------- 防護 2：@connect --------------------------- */

test('防護2：目標不在 @connect 清單裡 → 403，而且訊息講得出要加什麼', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['api.example.com'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'connect_not_allowed');
  assert.ok(result.body.message.includes('@connect'));
  assert.equal(apiUpstream.received.length, 0, '不准真的打出去');
});

test('防護2：@connect * → 拒絕，並說明要列出具體主機', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['*'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'connect_not_allowed');
  assert.ok(/具體主機/.test(result.body.message), result.body.message);
});

test('防護2：沒宣告 @connect 時，打第三方 → 403', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: [] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'connect_not_allowed');
});

test('⛔ 防護2+3：上游用 302 想把我們導去沒授權的主機 → 擋下來', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    apiHandler: (req, res) => {
      res.writeHead(302, { location: 'https://evil.test/steal' });
      res.end();
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/redirect` });

  // 目標主機是 127.0.0.1（授權過），但轉址後的 evil.test 沒授權
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'connect_not_allowed');
  assert.ok(result.body.message.includes('evil.test'), result.body.message);
});

/* ----------------------------- 防護 3：SSRF ----------------------------- */

test('防護3：不放行私網時，打 127.0.0.1 → 403 ssrf_blocked', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ssrf_blocked');
  assert.equal(apiUpstream.received.length, 0);
});

/* --------------------------- 防護 4：method --------------------------- */

test('防護4：method 不在白名單 → 400', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  for (const method of ['TRACE', 'CONNECT', 'OPTIONS', '隨便打']) {
    const result = await callXhr(app, {
      scriptId: script.id,
      method,
      url: `${apiUpstream.origin}/x`,
    });
    assert.equal(result.status, 400, method);
    assert.equal(result.body.error, 'method_not_allowed', method);
  }
});

test('防護4：白名單內的 method 都通', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    const result = await callXhr(app, {
      scriptId: script.id,
      method,
      url: `${apiUpstream.origin}/x`,
      data: method === 'GET' || method === 'HEAD' ? undefined : 'payload',
    });
    assert.equal(result.status, 200, `${method} → ${JSON.stringify(result.body)}`);
  }
});

test('url 不是 http(s) → 400', async (t) => {
  const { app } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  for (const url of ['file:///C:/Windows/win.ini', 'ftp://x.test/a', '不是網址', '']) {
    const result = await callXhr(app, { scriptId: script.id, url });
    assert.equal(result.status, 400, String(url));
    assert.equal(result.body.error, 'bad_url');
  }
});

/* ------------------------ 防護 5：大小與時間上限 ------------------------ */

test('防護5：上游宣告的 content-length 超過上限 → 413，而且不會把它讀進記憶體', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { gmXhr: { maxResponseBytes: 32 } } },
    apiHandler: (req, res) => {
      const payload = 'x'.repeat(5000);
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(payload.length) });
      res.end(payload);
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/big` });

  assert.equal(result.status, 413);
  assert.equal(result.body.error, 'response_too_large');
});

test('防護5：沒宣告長度（chunked）又超過上限 → 截斷並標 truncated', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { gmXhr: { maxResponseBytes: 16 } } },
    apiHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('0123456789');
      res.write('abcdefghijklmnop');
      res.end();
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/stream` });

  assert.equal(result.status, 200);
  assert.equal(result.body.truncated, true);
  assert.equal(result.body.responseText.length, 16);
});

test('防護5：上游不回應 → 504（不是一直掛著）', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { gmXhr: { timeoutMs: 150 } } },
    apiHandler: () => {
      /* 刻意不回應 */
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/slow` });

  assert.equal(result.status, 504);
  assert.equal(result.body.error, 'timeout');
});

/* --------------------- 防護 6：不轉送任何憑證 --------------------- */

test('⛔ 防護6：進來的 Authorization 與 Cookie 都不會被轉送出去', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  await callXhr(
    app,
    { scriptId: script.id, url: `${apiUpstream.origin}/x` },
    {
      headers: {
        authorization: `Bearer ${app.adminToken}`,
        cookie: `lm_site=demo; lm_admin=${app.adminToken}`,
      },
    },
  );

  const received = apiUpstream.lastRequest();
  assert.equal(received.headers.authorization, undefined, '後台 token 不准外流');
  assert.equal(received.headers.cookie, undefined, '瀏覽器的 cookie 不准外流');
  assert.equal(
    JSON.stringify(received.headers).includes(app.adminToken),
    false,
    `token 出現在轉送出去的 header 裡：${JSON.stringify(received.headers)}`,
  );
});

test('防護6：腳本自己帶的 cookie 只在打「站自己的 origin」時才送', async (t) => {
  const { app, apiUpstream, pageUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  await callXhr(app, {
    scriptId: script.id,
    url: `${apiUpstream.origin}/third-party`,
    headers: { cookie: 'session=abc' },
  });
  assert.equal(apiUpstream.lastRequest().headers.cookie, undefined, '第三方不給帶');

  await callXhr(app, {
    scriptId: script.id,
    url: `${pageUpstream.origin}/same-site`,
    headers: { cookie: 'session=abc' },
  });
  assert.equal(pageUpstream.lastRequest().headers.cookie, 'session=abc');
});

test('防護6：host header 不會被腳本換掉', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  await callXhr(app, {
    scriptId: script.id,
    url: `${apiUpstream.origin}/x`,
    headers: { host: 'evil.test' },
  });

  assert.notEqual(apiUpstream.lastRequest().headers.host, 'evil.test');
});

test('防護6：上游的 set-cookie 不會回給腳本', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    apiHandler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': 'tracker=1; Path=/',
      });
      res.end('ok');
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  const headerNames = Object.keys(result.body.headers).map((name) => name.toLowerCase());
  assert.equal(headerNames.includes('set-cookie'), false, `回了 set-cookie：${headerNames.join(',')}`);
});

/* ------------------------- 防護 7：速率限制 ------------------------- */

test('防護7：同一個站呼叫太頻繁 → 429 並帶 Retry-After', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { gmXhr: { rateLimit: 2, rateWindowMs: 60_000 } } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });
  const request = { scriptId: script.id, url: `${apiUpstream.origin}/x` };

  assert.equal((await callXhr(app, request)).status, 200);
  assert.equal((await callXhr(app, request)).status, 200);

  const blocked = await callXhr(app, request);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

/* ------------------------------ 其他 ------------------------------ */

test('body 不是合法 JSON → 400 invalid_json', async (t) => {
  const { app } = await arrange(t);

  const result = await callXhr(app, '{壞掉的');

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_json');
});

test('GET /__lm/gm/xhr（用錯 method）→ 404，不會變成別的東西', async (t) => {
  const { app } = await arrange(t);

  const response = await fetch(`${app.base}/__lm/gm/xhr`);
  assert.equal(response.status, 404);
  await response.text();
});

test('gm/xhr 不需要後台 token（被代理頁面是匿名的）', async (t) => {
  const { app, apiUpstream } = await arrange(t);
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });
  assert.equal(result.status, 200);
});

/* ------------- GM 白名單（LOCALMONKEY_GM_ALLOW_HOSTS）：真實腳本的場景 ------------- */

/**
 * ig-helper / threads-helper / xpost-card 都宣告 `@connect localhost`，實際目標是
 * AutoReel 後端 http://localhost:8001。照原本的 SSRF 防護這三支會全滅，而且是
 * 「腳本看起來有跑、請求靜默失敗」那種最難除錯的失敗。
 *
 * 白名單只影響這個端點、精確比對 host:port、預設空的，而且 @connect 還是要過。
 */

test('⭐ 白名單命中 → 打得到本機後端（這就是三支真實腳本要的）', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  // 把假後端的確切 host:port 放進白名單
  app.config.gmXhr.allowHosts = [new URL(apiUpstream.origin).host];

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/api/jobs` });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(apiUpstream.lastRequest().url, '/api/jobs');
});

test('白名單沒命中 → 照樣被 SSRF 擋掉', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  app.config.gmXhr.allowHosts = ['localhost:9999'];

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ssrf_blocked');
  assert.equal(apiUpstream.received.length, 0);
});

test('⛔ 白名單不會繞過 @connect：兩道都要過', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  // 腳本只宣告了別的主機，沒宣告這個後端
  const script = seedScript(app, { connect: ['api.example.com'] });

  app.config.gmXhr.allowHosts = [new URL(apiUpstream.origin).host];

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'connect_not_allowed');
  assert.equal(apiUpstream.received.length, 0);
});

test('⛔ 白名單是「精確比對」：port 不同就不算', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  const host = new URL(apiUpstream.origin).host;
  app.config.gmXhr.allowHosts = [host.replace(/:\d+$/, ':1')];

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` });

  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ssrf_blocked');
});

test('⛔ 白名單裡的主機不能被 302 當跳板導到別的私網主機', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
    apiHandler: (req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/internal' });
      res.end();
    },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  app.config.gmXhr.allowHosts = [new URL(apiUpstream.origin).host];

  const result = await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/redirect` });

  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, 'ssrf_blocked', '轉址後的主機不在白名單裡');
});

test('預設（白名單空的）就是擋掉本機目標', async (t) => {
  const { app, apiUpstream } = await arrange(t, {
    appOptions: { config: { allowPrivate: false } },
  });
  const script = seedScript(app, { connect: ['127.0.0.1'] });

  assert.deepEqual(app.config.gmXhr.allowHosts ?? [], []);
  assert.equal((await callXhr(app, { scriptId: script.id, url: `${apiUpstream.origin}/x` })).status, 403);
});
