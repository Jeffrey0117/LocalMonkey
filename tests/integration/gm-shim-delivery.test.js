'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');
const { parseUserscript } = require('../../src/userscript/parse.js');

const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>x</h1></body></html>';

async function arrange(t) {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const app = await startApp();

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  app.store.sites.create({ id: 'demo', name: 'demo', target_origin: upstream.origin });
  return { app, upstream };
}

/** 從真的 userscript 原文建腳本（跟部署流程一樣，metadata 來自解析器） */
function seed(app, source, { extraMetadata = {} } = {}) {
  const parsed = parseUserscript(source);
  const script = app.store.userscripts.create({
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    source,
    metadata: { ...parsed, requireAssets: [], resourceAssets: [], ...extraMetadata },
    run_at: parsed.runAt,
  });

  app.store.userscripts.setBindings(script.id, [{ site_id: 'demo', path_glob: '*' }]);
  return script;
}

function userscript(lines, body = "GM_setValue('k', 1);") {
  return ['// ==UserScript==', ...lines, '// ==/UserScript==', '', body].join('\n');
}

test('有 @grant → shim 注入在使用者腳本之前，而且投遞得出來', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript(['// @name 用得到 GM', '// @match https://demo.test/*', '// @grant GM_setValue']),
  );

  const page = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.ok(
    page.indexOf(`/__lm/shim/${script.id}.js`) < page.indexOf(`/__lm/script/${script.id}.js`),
    'shim 要排在使用者腳本之前',
  );

  const shim = await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` });
  assert.equal(shim.status, 200);
  assert.match(shim.headers['content-type'], /application\/javascript/);
  assert.equal(shim.headers['cache-control'], 'no-cache');
  assert.ok(shim.text.includes('window.__localMonkey.install('));
  assert.ok(shim.text.includes(script.id));
});

test('@grant none → 不投遞 shim（頁面沒有 shim tag，端點也是 404）', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript(['// @name 不要 GM', '// @match https://demo.test/*', '// @grant none'], 'document.title = "x";'),
  );

  const page = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.equal(page.includes(`/__lm/shim/${script.id}.js`), false);
  assert.ok(page.includes(`/__lm/script/${script.id}.js`), '腳本本身還是要注入');

  const shim = await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` });
  assert.equal(shim.status, 404);
});

test('完全沒宣告 @grant → 也不投遞 shim', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript(['// @name 沒宣告', '// @match https://demo.test/*'], 'document.title = "x";'),
  );

  const page = (await rawRequest({ port: app.port, path: '/p/demo/' })).text;
  assert.equal(page.includes(`/__lm/shim/${script.id}.js`), false);
  assert.equal((await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).status, 404);
});

test('投遞的腳本只宣告 @grant 過的名字（沒 grant 的不會出現在 scope 裡）', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript([
      '// @name 只要兩個',
      '// @match https://demo.test/*',
      '// @grant GM_setValue',
      '// @grant GM_addStyle',
    ]),
  );

  const delivered = (await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` })).text;

  assert.ok(delivered.includes('var GM_setValue = __lmApi["GM_setValue"];'));
  assert.ok(delivered.includes('var GM_addStyle = __lmApi["GM_addStyle"];'));
  assert.equal(delivered.includes('var GM_xmlhttpRequest'), false);
  assert.equal(delivered.includes('var GM_getValue'), false);
  assert.ok(delivered.includes(`apis[\"${script.id}\"]`.replace(/\\/g, '')));
});

test('GM4 的點號形式只宣告一個 GM 物件', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript([
      '// @name GM4',
      '// @match https://demo.test/*',
      '// @grant GM.setValue',
      '// @grant GM.getValue',
    ]),
  );

  const delivered = (await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` })).text;
  const declarations = delivered.split('var GM = __lmApi["GM"];').length - 1;

  assert.equal(declarations, 1);
});

test('⛔ @grant 的值不是合法識別字時，絕對不能變成程式碼', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript([
      '// @name 注入嘗試',
      '// @match https://demo.test/*',
      '// @grant GM_setValue',
      '// @grant x; window.PWNED = 1; var y',
    ]),
  );

  const delivered = (await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` })).text;
  const shim = (await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).text;

  // 那串字會出現在投遞內容裡 —— 但只因為它是使用者原文的 `// @grant` 註解行。
  // 真正的問題是「它會不會變成可執行的程式碼」，所以直接把投遞的 JS 跑一遍。
  assert.equal(delivered.includes('var x; window.PWNED'), false, '不能變成變數宣告');
  assert.ok(delivered.includes('var GM_setValue = __lmApi["GM_setValue"];'));

  const sandbox = {
    window: {},
    document: { readyState: 'complete', addEventListener: () => {} },
    console: { error: () => {}, warn: () => {} },
  };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => new vm.Script(delivered).runInContext(sandbox));
  assert.equal(sandbox.window.PWNED, undefined, '被注入了');

  // shim 的 config 是 JSON：字串進得去，但永遠只是字串，不會被當識別字用
  assert.equal(shim.includes('var x; window.PWNED'), false);
});

test('不支援的 GM API 會進 shim config 的 unsupported（前端才能標紅字）', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript([
      '// @name 用到沒支援的',
      '// @match https://demo.test/*',
      '// @grant GM_cookie',
    ], 'GM_cookie({ action: "list" });'),
  );

  const shim = (await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).text;
  const config = JSON.parse(shim.slice(shim.lastIndexOf('install(') + 'install('.length, shim.lastIndexOf(');')));

  assert.deepEqual(config.unsupported, ['GM_cookie']);
  assert.deepEqual(config.grants, ['GM_cookie']);
});

test('shim config 帶 @connect、@match 與 GM_info 要的欄位', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript([
      '// @name 資訊完整',
      '// @version 3.1',
      '// @namespace https://ns.test',
      '// @match https://demo.test/*',
      '// @match https://other.test/items/*',
      '// @exclude https://demo.test/admin/*',
      '// @connect api.example.com',
      '// @grant GM_info',
      '// @grant GM_xmlhttpRequest',
    ]),
  );

  const shim = (await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).text;
  const config = JSON.parse(shim.slice(shim.lastIndexOf('install(') + 'install('.length, shim.lastIndexOf(');')));

  assert.equal(config.name, '資訊完整');
  assert.equal(config.version, '3.1');
  assert.equal(config.namespace, 'https://ns.test');
  assert.deepEqual(config.connect, ['api.example.com']);
  assert.deepEqual(config.matches, ['https://demo.test/*', 'https://other.test/items/*']);
  assert.deepEqual(config.excludes, ['https://demo.test/admin/*']);
  assert.equal(config.xhrEndpoint, '/__lm/gm/xhr');
});

test('@resource 的文字內容會嵌進 shim（GM_getResourceText 是同步 API）', async (t) => {
  const { app } = await arrange(t);
  const asset = app.store.assets.put({
    url: 'https://cdn.test/theme.css',
    content: Buffer.from('body{background:#000}', 'utf8'),
    content_type: 'text/css',
  });

  const script = seed(
    app,
    userscript([
      '// @name 有資源',
      '// @match https://demo.test/*',
      '// @resource theme https://cdn.test/theme.css',
      '// @grant GM_getResourceText',
    ]),
    {
      extraMetadata: {
        resourceAssets: [{ name: 'theme', url: 'https://cdn.test/theme.css', sha256: asset.sha256 }],
      },
    },
  );

  const shim = (await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).text;
  const config = JSON.parse(shim.slice(shim.lastIndexOf('install(') + 'install('.length, shim.lastIndexOf(');')));

  assert.equal(config.resources.theme.text, 'body{background:#000}');
  assert.equal(config.resources.theme.assetUrl, `/__lm/asset/${asset.sha256}`);
});

test('停用的腳本沒有 shim', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript(['// @name 停用', '// @match https://demo.test/*', '// @grant GM_setValue']),
  );
  app.store.userscripts.update(script.id, { enabled: 0 });

  assert.equal((await rawRequest({ port: app.port, path: `/__lm/shim/${script.id}.js` })).status, 404);
});

test('shim 路徑要 .js 結尾、不存在的 id → 404', async (t) => {
  const { app } = await arrange(t);

  for (const path of ['/__lm/shim/scr_ghost.js', '/__lm/shim/scr_ghost', '/__lm/shim/..%2f..%2fpackage.json']) {
    assert.equal((await rawRequest({ port: app.port, path })).status, 404, path);
  }
});

test('shim 不需要後台 token（瀏覽器匿名載它）', async (t) => {
  const { app } = await arrange(t);
  const script = seed(
    app,
    userscript(['// @name 匿名', '// @match https://demo.test/*', '// @grant GM_setValue']),
  );

  const response = await rawRequest({
    port: app.port,
    path: `/__lm/shim/${script.id}.js`,
    headers: { cookie: '' },
  });

  assert.equal(response.status, 200);
});
