'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream, TINY_PNG } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

/** 起一組「假上游 + 代理」，並把收掉的事情交給 t.after */
async function arrange(t, { handler, siteOptions = {}, appOptions = {} } = {}) {
  const upstream = await startUpstream(
    handler ??
      ((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('upstream ok');
      }),
  );
  const app = await startApp(appOptions);

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const seeded = seedSite(app.store, { targetOrigin: upstream.origin, ...siteOptions });
  return { upstream, app, ...seeded };
}

test('GET 經過代理後回上游內容', async (t) => {
  const { app } = await arrange(t);
  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 200);
  assert.equal(response.text, 'upstream ok');
});

test('URL 組裝：path、query、尾斜線、編碼字元都原樣送到上游', async (t) => {
  const { app, upstream } = await arrange(t);

  const cases = [
    ['/p/demo/', '/'],
    ['/p/demo', '/'],
    ['/p/demo/a/b/c', '/a/b/c'],
    ['/p/demo/dir/', '/dir/'],
    ['/p/demo/search?q=hello%20world&page=2', '/search?q=hello%20world&page=2'],
    ['/p/demo/%E4%B8%AD%E6%96%87.html', '/%E4%B8%AD%E6%96%87.html'],
    ['/p/demo/a+b?c=d%2Be', '/a+b?c=d%2Be'],
    ['/p/demo/path?empty=', '/path?empty='],
  ];

  for (const [proxyPath, expected] of cases) {
    await rawRequest({ port: app.port, path: proxyPath });
    assert.equal(upstream.lastRequest().url, expected, `${proxyPath} 應該變成 ${expected}`);
  }
});

test('請求 header：hop-by-hop 被拿掉、host 換成上游、其他原樣轉送', async (t) => {
  const { app, upstream } = await arrange(t);

  await rawRequest({
    port: app.port,
    path: '/p/demo/',
    headers: {
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      te: 'trailers',
      // 註：`trailer` 沒放進來是因為 node 的 http client 不准在非 chunked 的請求上送它
      // （ERR_HTTP_TRAILER_INVALID）。它的過濾在 tests/unit/headers.test.js 驗。
      'proxy-connection': 'keep-alive',
      'proxy-authorization': 'Basic nope',
      cookie: 'upstream_session=abc',
      'user-agent': 'LocalMonkeyTest/1.0',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-TW,zh;q=0.9',
      'x-custom': 'passthrough',
    },
  });

  const forwarded = upstream.lastRequest().headers;
  assert.equal(forwarded.host, `127.0.0.1:${upstream.port}`);
  assert.equal(forwarded.cookie, 'upstream_session=abc');
  assert.equal(forwarded['user-agent'], 'LocalMonkeyTest/1.0');
  assert.equal(forwarded.accept, 'text/html,application/xhtml+xml');
  assert.equal(forwarded['accept-language'], 'zh-TW,zh;q=0.9');
  assert.equal(forwarded['x-custom'], 'passthrough');

  for (const dropped of ['keep-alive', 'te', 'proxy-connection', 'proxy-authorization']) {
    assert.equal(forwarded[dropped], undefined, `${dropped} 不該送到上游`);
  }
});

test('回應 header：CSP / X-Frame-Options / content-encoding 被拿掉，其他保留', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
        'strict-transport-security': 'max-age=63072000',
        'cross-origin-opener-policy': 'same-origin',
        'x-keep-me': 'yes',
      });
      res.end('<html><body>hi</body></html>');
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.headers['content-security-policy'], undefined);
  assert.equal(response.headers['x-frame-options'], undefined);
  assert.equal(response.headers['strict-transport-security'], undefined);
  assert.equal(response.headers['cross-origin-opener-policy'], undefined);
  assert.equal(response.headers['x-keep-me'], 'yes');
  assert.match(response.headers['content-type'], /text\/html/);
});

test('上游回 gzip：body 解壓後送出，content-encoding 不留下來（不然瀏覽器解不開）', async (t) => {
  const html = '<html><body><p>壓縮過的中文</p></body></html>';
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
      });
      res.end(zlib.gzipSync(Buffer.from(html, 'utf8')));
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.headers['content-encoding'], undefined);
  assert.ok(response.text.includes('壓縮過的中文'));
});

test('POST：method 與 body 都要到上游，content-type 保留', async (t) => {
  const { app, upstream } = await arrange(t, {
    handler: (req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoedBytes: body.length }));
    },
  });

  const payload = JSON.stringify({ hello: '世界' });
  const response = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/p/demo/api/submit',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });

  const received = upstream.lastRequest();
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/submit');
  assert.equal(received.body.toString('utf8'), payload);
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(response.text).echoedBytes, Buffer.byteLength(payload));
});

test('POST 沒有 body 也不能爆（CF tunnel 會把它變成 chunked）', async (t) => {
  const { app, upstream } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/p/demo/bodyless',
    headers: { 'content-length': '0' },
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.lastRequest().method, 'POST');
});

test('binary 原樣回傳：PNG 要 byte-for-byte 一致', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
    },
    siteOptions: {
      scripts: [{ name: '不該出現在圖片裡', code: 'console.info(1)' }],
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/pixel.png' });

  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(Buffer.compare(response.body, TINY_PNG), 0, 'PNG 不可以被動到');
});

test('PUT / DELETE / PATCH / HEAD 都轉送', async (t) => {
  const { app, upstream } = await arrange(t);

  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const response = await rawRequest({ port: app.port, method, path: '/p/demo/thing' });
    assert.equal(response.status, 200, `${method} 應該要成功`);
    assert.equal(upstream.lastRequest().method, method);
  }
});

test('上游掛掉 → 502、有人看得懂的說明、不洩漏堆疊', async (t) => {
  const upstreamDown = await startUpstream((req, res) => res.end('ok'));
  const deadOrigin = upstreamDown.origin;
  await upstreamDown.close();

  const app = await startApp();
  t.after(() => app.close());
  seedSite(app.store, { targetOrigin: deadOrigin });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 502);
  assert.ok(response.text.includes(deadOrigin), '要告訴使用者目標是誰');
  assert.ok(response.text.length > 80, '不可以只回一句「代理請求失敗」');
  assert.equal(/at .*\(.*:\d+:\d+\)/.test(response.text), false, '不准把 stack trace 吐給使用者');
  assert.equal(response.text.includes('node:internal'), false);
});

test('不存在的 siteId → 404 並說明原因', async (t) => {
  const { app } = await arrange(t);
  const response = await rawRequest({ port: app.port, path: '/p/nosuchsite/' });

  assert.equal(response.status, 404);
  assert.ok(response.text.includes('nosuchsite'));
});

test('停用的網站不代理', async (t) => {
  const { app } = await arrange(t, { siteOptions: { enabled: 0 } });
  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 404);
  assert.ok(response.text.includes('停用'));
});

test('請求時的 SSRF 檢查：不放行私網時，指向 127.0.0.1 的網站會被擋（DNS rebinding 防線）', async (t) => {
  const { app } = await arrange(t, { appOptions: { config: { allowPrivate: false } } });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 403);
  assert.ok(response.text.includes('LOCALMONKEY_ALLOW_PRIVATE'), '要告訴使用者怎麼放行');
});

test('上游的 4xx/5xx 狀態碼原樣轉述', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(451, { 'content-type': 'text/plain' });
      res.end('gone fishing');
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  assert.equal(response.status, 451);
  assert.equal(response.text, 'gone fishing');
});

test('304 這種沒有 body 的回應不會壞掉', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(304, { etag: 'W/"x"' });
      res.end();
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/cached.css' });
  assert.equal(response.status, 304);
  assert.equal(response.body.length, 0);
});
