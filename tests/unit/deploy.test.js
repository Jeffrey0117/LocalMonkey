'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { deployUserscript } = require('../../src/services/deploy.js');
const { silentLogger } = require('../../src/logger.js');

/** 假 DNS：讓所有主機都解析成公開 IP，測試才不用碰網路 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function deps(t, { fetchImpl, config = {} } = {}) {
  const store = createStore(openDatabase(':memory:'));
  t.after(() => store.db.close());

  return {
    store,
    logger: silentLogger,
    lookup: publicLookup,
    fetchImpl:
      fetchImpl ??
      (() => {
        throw new Error('這個測試不該發出任何請求');
      }),
    config: {
      allowPrivate: false,
      assetTimeoutMs: 5_000,
      assetMaxBytes: 5 * 1024 * 1024,
      ...config,
    },
  };
}

function script(lines, body = "console.log('x');") {
  return ['// ==UserScript==', ...lines, '// ==/UserScript==', '', body].join('\n');
}

function jsResponse(text, { status = 200, contentType = 'application/javascript' } = {}) {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

/* --------------------------- 建站與綁定 --------------------------- */

test('兩個 @match → 自動建兩個站，腳本同時掛上去', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script([
      '// @name 兩個網域',
      '// @match https://www.example.com/*',
      '// @match https://seller.shopee.tw/items/*',
    ]),
  });

  assert.equal(result.targets.length, 2);
  assert.deepEqual(
    result.targets.map((target) => target.proxyable),
    ['ready', 'ready'],
  );

  const sites = context.store.sites.list();
  assert.deepEqual(
    sites.map((site) => [site.id, site.target_origin, site.auto_created]),
    [
      ['example-com', 'https://www.example.com', true],
      ['seller-shopee-tw', 'https://seller.shopee.tw', true],
    ],
  );

  assert.deepEqual(
    result.script.sites.map((binding) => [binding.site_id, binding.path_glob]),
    [
      ['example-com', '*'],
      ['seller-shopee-tw', '/items/**'],
    ],
  );
});

test('from_pattern 記下來源 @match（UI 要給使用者看）', async (t) => {
  const context = deps(t);

  await deployUserscript(context, {
    source: script(['// @name x', '// @match https://*.example.com/*']),
  });

  const site = context.store.sites.get('example-com');
  assert.equal(site.from_pattern, 'https://*.example.com/*');
  assert.equal(site.auto_created, true);
});

test('已經有同一個 target_origin 的站就重複用，不會長出第二個', async (t) => {
  const context = deps(t);
  context.store.sites.create({
    id: 'my-own-name',
    name: '我自己建的',
    target_origin: 'https://www.example.com',
  });

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://www.example.com/*']),
  });

  assert.equal(context.store.sites.list().length, 1);
  assert.equal(result.targets[0].siteId, 'my-own-name');
  assert.equal(context.store.sites.get('my-own-name').auto_created, false, '不要去改使用者建的站');
});

test('萬用子網域 → 建在主網域上，狀態保留 needs-host 讓 UI 標示', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://*.shopee.tw/*']),
  });

  assert.equal(result.targets[0].proxyable, 'needs-host');
  assert.equal(result.targets[0].siteId, 'shopee-tw');
  assert.equal(context.store.sites.get('shopee-tw').target_origin, 'https://shopee.tw');
  assert.ok(result.targets[0].reason.includes('子網域'));
});

test('被拒絕的 @match 不建站，但原因要留著', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match <all_urls>', '// @match https://ok.test/*']),
  });

  const [rejected, ready] = result.targets;
  assert.equal(rejected.proxyable, 'rejected');
  assert.equal(rejected.siteId, null);
  assert.ok(rejected.reason.length > 0);
  assert.equal(ready.proxyable, 'ready');

  assert.deepEqual(
    context.store.sites.list().map((site) => site.id),
    ['ok-test'],
  );
});

test('slug 撞到別的 target_origin → 加數字後綴', async (t) => {
  const context = deps(t);
  context.store.sites.create({
    id: 'example-com',
    name: '先來的',
    target_origin: 'https://example.com',
  });

  await deployUserscript(context, {
    source: script(['// @name x', '// @match https://www.example.com/*']),
  });

  assert.ok(context.store.sites.get('example-com-2'), '要有第二個站');
  assert.equal(context.store.sites.get('example-com-2').target_origin, 'https://www.example.com');
});

test('@exclude 會跟著對應的站進綁定', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script([
      '// @name x',
      '// @match https://a.test/*',
      '// @match https://b.test/*',
      '// @exclude https://a.test/admin/*',
      '// @exclude_match *://*/login',
    ]),
  });

  const bindings = result.script.sites;
  const a = bindings.find((binding) => binding.site_id === 'a-test');
  const b = bindings.find((binding) => binding.site_id === 'b-test');

  assert.deepEqual(a.exclude_globs, ['/admin/**', '/login'], 'a.test 專屬的排除 + 萬用的排除');
  assert.deepEqual(b.exclude_globs, ['/login'], '別站的排除不該套到 b.test');
});

test('http:// 的 @match 照收，並標示不安全', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match http://old.test/*']),
  });

  assert.equal(result.targets[0].insecure, true);
  assert.equal(context.store.sites.get('old-test').target_origin, 'http://old.test');
});

/* --------------------------- 重新部署 --------------------------- */

test('⭐ 重新部署：改 source 會重算綁定（拿掉的 @match 會解綁）', async (t) => {
  const context = deps(t);

  const first = await deployUserscript(context, {
    source: script(['// @name 原本', '// @version 1.0', '// @match https://a.test/*', '// @match https://b.test/*']),
  });

  const second = await deployUserscript(context, {
    scriptId: first.script.id,
    source: script(['// @name 改名了', '// @version 2.0', '// @match https://a.test/shop/*']),
  });

  assert.equal(second.script.id, first.script.id, '同一支腳本，不是新建一支');
  assert.equal(second.script.name, '改名了');
  assert.equal(second.script.version, '2.0');
  assert.deepEqual(
    second.script.sites.map((binding) => [binding.site_id, binding.path_glob]),
    [['a-test', '/shop/**']],
  );

  assert.deepEqual(context.store.userscripts.listForInjection('b-test'), [], 'b.test 要被解綁');
  assert.ok(context.store.sites.get('b-test'), '站本身留著（使用者可以自己刪）');
});

test('重新部署時 run_at 與 metadata 都跟著更新', async (t) => {
  const context = deps(t);

  const first = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*']),
  });
  assert.equal(first.script.run_at, 'document-end');
  assert.equal(first.script.metadata.needsShim, false);

  const second = await deployUserscript(context, {
    scriptId: first.script.id,
    source: script([
      '// @name x',
      '// @match https://a.test/*',
      '// @run-at document-start',
      '// @grant GM_setValue',
    ]),
  });

  assert.equal(second.script.run_at, 'document-start');
  assert.equal(second.script.metadata.needsShim, true);
  assert.deepEqual(second.script.metadata.grants, ['GM_setValue']);
});

test('重新部署不存在的 id → 丟錯', async (t) => {
  const context = deps(t);

  await assert.rejects(
    () => deployUserscript(context, { scriptId: 'scr_ghost', source: script(['// @name x']) }),
    /找不到/,
  );
});

test('enabled / order_index 可以一起帶', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*']),
    enabled: 0,
    order_index: 7,
  });

  assert.equal(result.script.enabled, false);
  assert.equal(result.script.order_index, 7);
});

/* --------------------------- 沒有 header --------------------------- */

test('沒有 metadata block：照樣存得起來，但沒有綁定，而且留下提示', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: "document.title = '純 JS';",
    fallbackName: 'my-snippet.user.js',
  });

  assert.equal(result.script.name, 'my-snippet.user.js');
  assert.deepEqual(result.script.sites, []);
  assert.deepEqual(result.targets, []);
  assert.ok(result.warnings.some((warning) => /header/.test(warning)));
});

/* --------------------------- @require / @resource --------------------------- */

test('@require 抓下來內容定址，metadata 記下 sha256（注入順序照宣告）', async (t) => {
  const fetched = [];
  const context = deps(t, {
    fetchImpl: (url) => {
      fetched.push(String(url));
      return Promise.resolve(jsResponse(`/* ${url} */`));
    },
  });

  const result = await deployUserscript(context, {
    source: script([
      '// @name x',
      '// @match https://a.test/*',
      '// @require https://cdn.test/one.js',
      '// @require https://cdn.test/two.js',
    ]),
  });

  assert.deepEqual(fetched, ['https://cdn.test/one.js', 'https://cdn.test/two.js']);

  const assets = result.script.metadata.requireAssets;
  assert.equal(assets.length, 2);
  assert.deepEqual(
    assets.map((asset) => asset.url),
    ['https://cdn.test/one.js', 'https://cdn.test/two.js'],
  );
  assert.ok(assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)));

  const stored = context.store.assets.get(assets[0].sha256);
  assert.equal(stored.content.toString('utf8'), '/* https://cdn.test/one.js */');
});

test('同一個 @require URL 出現兩次只抓一次', async (t) => {
  let calls = 0;
  const context = deps(t, {
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(jsResponse('lib'));
    },
  });

  await deployUserscript(context, {
    source: script([
      '// @name x',
      '// @match https://a.test/*',
      '// @require https://cdn.test/same.js',
      '// @require https://cdn.test/same.js',
    ]),
  });

  assert.equal(calls, 1);
});

test('已經抓過的 URL 不會再抓（跨存檔也只抓一次）', async (t) => {
  let calls = 0;
  const context = deps(t, {
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(jsResponse('lib'));
    },
  });

  const source = script(['// @name x', '// @match https://a.test/*', '// @require https://cdn.test/lib.js']);

  const first = await deployUserscript(context, { source });
  const second = await deployUserscript(context, { scriptId: first.script.id, source });

  assert.equal(calls, 1, '第二次存檔不該再打 CDN');
  assert.equal(
    second.script.metadata.requireAssets[0].sha256,
    first.script.metadata.requireAssets[0].sha256,
  );
});

test('@require 抓失敗 → 腳本照樣存起來，但標示失效', async (t) => {
  const context = deps(t, {
    fetchImpl: () => Promise.reject(new Error('CDN 掛了')),
  });

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*', '// @require https://cdn.test/dead.js']),
  });

  assert.ok(result.script.id, '腳本本身要存得起來');
  const [asset] = result.script.metadata.requireAssets;
  assert.equal(asset.sha256, null);
  assert.ok(asset.error.length > 0);
  assert.ok(result.warnings.some((warning) => warning.includes('dead.js')));
});

test('@require 回非 2xx → 當成失敗，但不擋存檔', async (t) => {
  const context = deps(t, {
    fetchImpl: () => Promise.resolve(jsResponse('not found', { status: 404 })),
  });

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*', '// @require https://cdn.test/404.js']),
  });

  assert.equal(result.script.metadata.requireAssets[0].sha256, null);
  assert.ok(result.warnings.some((warning) => /404/.test(warning)));
});

test('@require 超過大小上限 → 不存，標示失效', async (t) => {
  const context = deps(t, {
    config: { assetMaxBytes: 10 },
    fetchImpl: () => Promise.resolve(jsResponse('x'.repeat(500))),
  });

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*', '// @require https://cdn.test/big.js']),
  });

  assert.equal(result.script.metadata.requireAssets[0].sha256, null);
  assert.ok(result.warnings.some((warning) => /大|上限/.test(warning)));
  assert.equal(context.store.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
});

test('⛔ @require 指向私網 → 被 SSRF 防護擋下來（不准拿它當跳板）', async (t) => {
  const context = deps(t, {
    lookup: undefined,
    fetchImpl: () => {
      throw new Error('不該真的發出去');
    },
  });
  context.lookup = async () => [{ address: '127.0.0.1', family: 4 }];

  const result = await deployUserscript(context, {
    source: script(['// @name x', '// @match https://a.test/*', '// @require https://internal.test/x.js']),
  });

  assert.equal(result.script.metadata.requireAssets[0].sha256, null);
  assert.ok(
    result.warnings.some((warning) => /內部位址|私網|SSRF/.test(warning)),
    JSON.stringify(result.warnings),
  );
});

test('@resource 一樣存進 assets，並記下名稱', async (t) => {
  const context = deps(t, {
    fetchImpl: () => Promise.resolve(jsResponse('body{}', { contentType: 'text/css' })),
  });

  const result = await deployUserscript(context, {
    source: script([
      '// @name x',
      '// @match https://a.test/*',
      '// @resource theme https://cdn.test/theme.css',
    ]),
  });

  const [resource] = result.script.metadata.resourceAssets;
  assert.equal(resource.name, 'theme');
  assert.equal(resource.url, 'https://cdn.test/theme.css');
  assert.match(resource.sha256, /^[0-9a-f]{64}$/);
  assert.equal(context.store.assets.get(resource.sha256).content_type, 'text/css');
});

test('metadata 存的就是解析結果（後端與前端看同一份）', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script([
      '// @name 完整',
      '// @version 1.1',
      '// @description 說明',
      '// @match https://a.test/*',
      '// @connect api.test',
      '// @grant GM_setValue',
      '// @grant GM_cookie',
      '// @noframes',
    ]),
  });

  const { metadata } = result.script;
  assert.equal(metadata.hasMetadataBlock, true);
  assert.deepEqual(metadata.connect, ['api.test']);
  assert.deepEqual(metadata.unsupportedGrants, ['GM_cookie']);
  assert.equal(metadata.noframes, true);
  assert.equal(metadata.needsShim, true);
  assert.equal(result.script.description, '說明');
  assert.ok(metadata.notices.some((notice) => notice.level === 'error'), '未支援的 GM API 要留 error');
});

test('source 空的 → 丟錯（不要存一支空腳本）', async (t) => {
  const context = deps(t);

  await assert.rejects(() => deployUserscript(context, { source: '   ' }), /空/);
});

/* ------------------- GM 白名單的存檔警告（靜默失敗是最糟的結果） ------------------- */

test('⭐ 腳本要連 localhost 但白名單沒放行 → 存檔時就警告，並附上要設的 env', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script([
      '// @name 打本機後端',
      '// @match https://www.instagram.com/*',
      '// @grant GM_xmlhttpRequest',
      '// @connect localhost',
    ]),
  });

  const warning = result.warnings.find((entry) => /LOCALMONKEY_GM_ALLOW_HOSTS/.test(entry));
  assert.ok(warning, `沒有警告：${JSON.stringify(result.warnings)}`);
  assert.ok(warning.includes('localhost'));
  assert.ok(/擋/.test(warning), '要說清楚會被擋掉');
});

test('白名單已經放行了就不要再警告（假警告會讓人不信警告）', async (t) => {
  const context = deps(t, { config: { gmXhr: { allowHosts: ['localhost:8001'] } } });

  const result = await deployUserscript(context, {
    source: script([
      '// @name 打本機後端',
      '// @match https://www.instagram.com/*',
      '// @grant GM_xmlhttpRequest',
      '// @connect localhost',
    ]),
  });

  assert.equal(
    result.warnings.some((entry) => /LOCALMONKEY_GM_ALLOW_HOSTS/.test(entry)),
    false,
    JSON.stringify(result.warnings),
  );
});

test('只連公開主機的腳本不會收到白名單警告', async (t) => {
  const context = deps(t);

  const result = await deployUserscript(context, {
    source: script([
      '// @name 打公開 API',
      '// @match https://x.com/*',
      '// @grant GM_xmlhttpRequest',
      '// @connect translate.googleapis.com',
      '// @connect pbs.twimg.com',
    ]),
  });

  assert.equal(
    result.warnings.some((entry) => /LOCALMONKEY_GM_ALLOW_HOSTS/.test(entry)),
    false,
  );
});
