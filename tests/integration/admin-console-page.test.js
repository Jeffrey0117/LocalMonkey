'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { startApp } = require('../support/app.js');
const { rawRequest } = require('../support/http.js');
const { PUBLIC_DIR } = require('../../src/routes/admin-page.js');

/**
 * 後台是瀏覽器端的程式，這裡測不到互動行為 —— 但可以測兩種會「整個壞掉卻無聲」
 * 的狀況：① 前端檔案語法錯誤 ② index.html 指到不存在的檔案。
 * 這兩個在沒有瀏覽器的環境下就是看不到，所以一定要有測試釘住。
 */

function publicScripts() {
  return fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(PUBLIC_DIR, name));
}

function referencedAssets() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const pattern = /(?:src|href)="(\/admin\/[^"]+)"/g;

  return [...html.matchAll(pattern)].map((match) => match[1]);
}

test('後台前端的每一支 JS 都是合法 JavaScript', () => {
  for (const file of publicScripts()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source), `${path.basename(file)} 語法有問題`);
  }
});

test('vendor 進來的 CodeMirror 是合法 JS，而且核心 / mode / addon 都串進去了', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'codemirror.js'), 'utf8');

  assert.doesNotThrow(() => new vm.Script(source));
  assert.ok(source.includes('defineMode("javascript"'), '少了 javascript mode');
  assert.ok(source.includes('matchBrackets'), '少了 matchbrackets addon');
  assert.ok(source.includes('autoCloseBrackets'), '少了 closebrackets addon');
  assert.ok(source.includes('styleActiveLine'), '少了 active-line addon');
});

test('CodeMirror 的授權檔跟著 vendor 進來了', () => {
  const license = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'CODEMIRROR-LICENSE.txt'), 'utf8');

  assert.ok(license.includes('MIT'), 'vendor 的程式碼要附授權');
  assert.ok(license.length > 500);
});

test('index.html 引用的每個 /admin/ 資源都真的送得出來', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const assets = referencedAssets();
  assert.ok(assets.length >= 8, `引用的資源太少，是不是漏了？${assets.join(', ')}`);

  for (const asset of assets) {
    const response = await rawRequest({
      port: app.port,
      path: asset,
      headers: { cookie: `lm_admin=${app.adminToken}` },
    });

    assert.equal(response.status, 200, `${asset} → ${response.status}`);
    assert.ok(response.body.length > 0, `${asset} 是空的`);
  }
});

test('/admin 回控制台的骨架（分頁、丟腳本、編輯器容器）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const response = await rawRequest({
    port: app.port,
    path: '/admin',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);

  for (const marker of [
    'data-tab="scripts"',
    'data-tab="sites"',
    'id="drop-open"',
    'id="editor"',
    'id="info-row"',
    'id="script-list"',
    'id="site-rows"',
    'id="drop-targets"',
    'id="delivery-url"',
    'id="delivery-rotate"',
    'id="version-hint"',
    'id="version-bump"',
  ]) {
    assert.ok(response.text.includes(marker), `骨架少了 ${marker}`);
  }
});

test('後台的前端檔案一樣要 token（沒 token 連 JS 都拿不到）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  for (const asset of ['/admin/app.js', '/admin/api.js', '/admin/vendor/codemirror.js']) {
    const response = await rawRequest({ port: app.port, path: asset });
    assert.equal(response.status, 401, asset);
  }
});

test('前端沒有留 console.log（規格：要 log 就用後端的 logger）', () => {
  for (const file of publicScripts()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(
      /console\.log\(/.test(source),
      false,
      `${path.basename(file)} 裡有 console.log`,
    );
  }
});

test('前端不會從外部網域載任何東西（離線可用、不洩漏瀏覽行為）', () => {
  const files = [...publicScripts(), path.join(PUBLIC_DIR, 'index.html'), path.join(PUBLIC_DIR, 'app.css')];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const external = source.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g) ?? [];

    assert.deepEqual(external, [], `${path.basename(file)} 引用了外部資源`);
  }
});
