'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

const PAGE = [
  '<!doctype html>',
  '<html><head><title>上游</title><link rel="stylesheet" href="/style.css"></head>',
  '<body><h1>原本的標題</h1>',
  '<script src="/assets/app.js"></script>',
  '<img src="//cdn.test/logo.png">',
  '<a href="https://other.test/x">外站</a>',
  '</body></html>',
].join('\n');

async function arrange(t, { scripts = [], handler, siteOptions = {}, appOptions = {} } = {}) {
  const upstream = await startUpstream(
    handler ??
      ((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      }),
  );
  const app = await startApp(appOptions);

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const seeded = seedSite(app.store, { targetOrigin: upstream.origin, scripts, ...siteOptions });
  return { upstream, app, ...seeded };
}

test('HTML：注入 script tag、改寫根絕對路徑、跨域路徑不動', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [{ name: '換標題', code: "document.querySelector('h1').textContent = 'LocalMonkey'" }],
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 200);
  assert.ok(response.text.includes(`<script src="/__lm/script/${scripts[0].id}.js"></script>`));
  assert.ok(response.text.includes('href="/p/demo/style.css"'));
  assert.ok(response.text.includes('src="/p/demo/assets/app.js"'));
  assert.ok(response.text.includes('src="//cdn.test/logo.png"'), 'protocol-relative 不該被動');
  assert.ok(response.text.includes('href="https://other.test/x"'), '外站連結不該被動');
});

test('HTML：使用者的 JS 不會被內嵌進頁面（要用外部 script）', async (t) => {
  const { app } = await arrange(t, {
    scripts: [{ name: 'inline 檢查', code: 'const marker = "SHOULD_NOT_BE_INLINE";' }],
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  assert.equal(response.text.includes('SHOULD_NOT_BE_INLINE'), false);
});

test('HTML：head-end 插在 </head> 前、body-end 插在 </body> 前', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [
      { name: '早一點', code: 'x', run_at: 'head-end' },
      { name: '晚一點', code: 'y', run_at: 'body-end' },
    ],
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  const headIndex = body.indexOf(`${scripts[0].id}.js`);
  const bodyIndex = body.indexOf(`${scripts[1].id}.js`);

  assert.ok(headIndex > -1 && bodyIndex > -1);
  assert.ok(headIndex < body.indexOf('</head>'));
  assert.ok(bodyIndex > body.indexOf('</head>'));
  assert.ok(bodyIndex < body.lastIndexOf('</body>'));
});

test('HTML：照 order_index 排序注入', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [
      { name: '第三', code: 'c', order_index: 30 },
      { name: '第一', code: 'a', order_index: 10 },
      { name: '第二', code: 'b', order_index: 20 },
    ],
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  const [third, first, second] = scripts;

  assert.ok(body.indexOf(first.id) < body.indexOf(second.id));
  assert.ok(body.indexOf(second.id) < body.indexOf(third.id));
});

test('HTML：停用的腳本不注入', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [
      { name: '開著', code: 'a' },
      { name: '關掉', code: 'b', enabled: 0 },
    ],
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.ok(body.includes(scripts[0].id));
  assert.equal(body.includes(scripts[1].id), false);
});

test('HTML：match_glob 不符就不注入，符合才注入', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [
      { name: '只在商店頁', code: 'a', match_glob: '/shop/**' },
      { name: '全站', code: 'b', match_glob: '*' },
    ],
  });
  const [shopOnly, everywhere] = scripts;

  const home = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.equal(home.includes(shopOnly.id), false);
  assert.ok(home.includes(everywhere.id));

  const shop = (await rawRequest({ port: app.port, path: '/p/demo/shop/item/42' })).text;
  assert.ok(shop.includes(shopOnly.id));
  assert.ok(shop.includes(everywhere.id));
});

test('HTML：match_glob 比對的是 path，不含 query', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [{ name: '搜尋頁', code: 'a', match_glob: '/search' }],
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/search?q=1' })).text;
  assert.ok(body.includes(scripts[0].id));
});

test('HTML：沒有 </body> 的頁面也注入得進去', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [{ name: '片段', code: 'a' }],
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<div>只有片段</div>');
    },
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.ok(body.startsWith('<div>只有片段</div>'));
  assert.ok(body.includes(scripts[0].id));
});

test('HTML 回應會設 lm_site cookie（讓根路徑 fallback 認得出來）', async (t) => {
  const { app } = await arrange(t);
  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  const cookie = response.setCookie.find((value) => value.startsWith('lm_site='));
  assert.ok(cookie, `沒看到 lm_site cookie：${JSON.stringify(response.setCookie)}`);
  assert.ok(cookie.includes('lm_site=demo'));
  assert.ok(/Path=\//.test(cookie));
  assert.ok(/SameSite=Lax/i.test(cookie));
});

test('非 HTML 回應不設 lm_site cookie（避免圖片請求亂搶）', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('body{}');
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/a.css' });
  assert.equal(
    response.setCookie.some((value) => value.startsWith('lm_site=')),
    false,
  );
});

test('set-cookie：Domain 與 Secure 被拿掉、SameSite 變 Lax、多條各自處理', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': [
          'session=abc; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=None',
          'theme=dark; Path=/; Max-Age=3600',
        ],
      });
      res.end('<html><body>x</body></html>');
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  const upstreamCookies = response.setCookie.filter((value) => !value.startsWith('lm_site='));

  assert.equal(upstreamCookies.length, 2, '兩條 cookie 要各自一條，不准合併');

  const [session, theme] = upstreamCookies;
  assert.ok(session.startsWith('session=abc'));
  assert.equal(/domain=/i.test(session), false);
  assert.equal(/\bsecure\b/i.test(session), false);
  assert.ok(/SameSite=Lax/.test(session));
  assert.ok(session.includes('HttpOnly'));

  assert.ok(theme.startsWith('theme=dark'));
  assert.ok(theme.includes('Max-Age=3600'));
});

test('3xx：指向上游自己的 location 改寫成代理路徑', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(302, { location: `${upstream.origin}/after-login?ok=1` });
    res.end();
  });
  const app = await startApp();
  t.after(async () => {
    await app.close();
    await upstream.close();
  });
  seedSite(app.store, { targetOrigin: upstream.origin });

  const response = await rawRequest({ port: app.port, path: '/p/demo/login' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/p/demo/after-login?ok=1');
});

test('3xx：指向別的網域原樣保留', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(301, { location: 'https://accounts.other.test/signin' });
      res.end();
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/login' });
  assert.equal(response.headers.location, 'https://accounts.other.test/signin');
});

test('3xx：根相對的 location 也掛上代理前綴', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(303, { location: '/dashboard' });
      res.end();
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/login' });
  assert.equal(response.headers.location, '/p/demo/dashboard');
});

test('content-type 是 XHTML 也當 HTML 處理', async (t) => {
  const { app, scripts } = await arrange(t, {
    scripts: [{ name: 'x', code: 'a' }],
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html;charset=big5' });
      res.end('<html><body></body></html>');
    },
  });

  const body = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.ok(body.includes(scripts[0].id));
});

test('JSON 回應不會被注入也不會被改寫', async (t) => {
  const payload = JSON.stringify({ href: '/assets/app.js', html: '</body>' });
  const { app } = await arrange(t, {
    scripts: [{ name: 'x', code: 'a' }],
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    },
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/api/data' });
  assert.equal(response.text, payload);
});
