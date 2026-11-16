'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminJson } = require('../support/app.js');
const { MAX_CODE_BYTES } = require('../../src/lib/validate.js');

async function arrange(t, options) {
  const app = await startApp(options);
  t.after(() => app.close());

  const call = (pathname, init) => adminJson(app.base, app.adminToken, pathname, init);
  const post = (pathname, payload) =>
    call(pathname, { method: 'POST', body: JSON.stringify(payload) });
  const put = (pathname, payload) =>
    call(pathname, { method: 'PUT', body: JSON.stringify(payload) });
  const del = (pathname) => call(pathname, { method: 'DELETE' });

  return { app, call, post, put, del };
}

const EXAMPLE = { id: 'example', name: 'Example', target_origin: 'https://example.com' };

test('建立網站 → 201，回傳完整物件', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/sites', EXAMPLE);

  assert.equal(response.status, 201);
  assert.equal(response.body.site.id, 'example');
  assert.equal(response.body.site.target_origin, 'https://example.com');
  assert.equal(response.body.site.enabled, true);
  assert.ok(response.body.site.created_at);
});

test('建立網站：target_origin 的尾斜線被正規化掉', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/sites', { ...EXAMPLE, target_origin: 'https://example.com/' });
  assert.equal(response.body.site.target_origin, 'https://example.com');
});

test('建立網站：id 重複 → 409', async (t) => {
  const { post } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  const response = await post('/admin/api/sites', EXAMPLE);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'duplicate_id');
});

test('建立網站：驗證失敗 → 400 並列出每個欄位的問題', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/sites', {
    id: 'BAD ID',
    name: '',
    target_origin: 'ftp://example.com',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'validation_failed');
  const fields = response.body.details.map((detail) => detail.field);
  assert.ok(fields.includes('id'));
  assert.ok(fields.includes('name'));
  assert.ok(fields.includes('target_origin'));
});

test('建立網站：保留字 slug 被拒', async (t) => {
  const { post } = await arrange(t);

  for (const id of ['admin', 'p', '__lm']) {
    const response = await post('/admin/api/sites', { ...EXAMPLE, id });
    assert.equal(response.status, 400, `${id} 應該被拒`);
  }
});

test('建立網站：指向私網 → 400 ssrf_blocked（預設不放行）', async (t) => {
  const { post } = await arrange(t, { config: { allowPrivate: false } });

  const response = await post('/admin/api/sites', {
    ...EXAMPLE,
    target_origin: 'http://192.168.0.11:8080',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'ssrf_blocked');
  assert.ok(response.body.message.includes('LOCALMONKEY_ALLOW_PRIVATE'));
});

test('建立網站：LOCALMONKEY_ALLOW_PRIVATE=1 時私網可以過', async (t) => {
  const { post } = await arrange(t, { config: { allowPrivate: true } });

  const response = await post('/admin/api/sites', {
    ...EXAMPLE,
    target_origin: 'http://127.0.0.1:3000',
  });
  assert.equal(response.status, 201);
});

test('列出網站：依建立時間排序', async (t) => {
  const { post, call } = await arrange(t);
  await post('/admin/api/sites', { ...EXAMPLE, id: 'first' });
  await post('/admin/api/sites', { ...EXAMPLE, id: 'second' });

  const response = await call('/admin/api/sites');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sites.map((site) => site.id),
    ['first', 'second'],
  );
});

test('單一網站：找得到 200、找不到 404', async (t) => {
  const { post, call } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  assert.equal((await call('/admin/api/sites/example')).status, 200);

  const missing = await call('/admin/api/sites/ghost');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
});

test('更新網站：部分欄位、回傳新物件', async (t) => {
  const { post, put } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  const response = await put('/admin/api/sites/example', { name: '改過的名字', enabled: false });

  assert.equal(response.status, 200);
  assert.equal(response.body.site.name, '改過的名字');
  assert.equal(response.body.site.enabled, false);
  assert.equal(response.body.site.target_origin, 'https://example.com');
});

test('更新網站：不存在 404、空 body 400、改 id 400', async (t) => {
  const { post, put } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  assert.equal((await put('/admin/api/sites/ghost', { name: 'x' })).status, 404);
  assert.equal((await put('/admin/api/sites/example', {})).status, 400);
  assert.equal((await put('/admin/api/sites/example', { id: 'other' })).status, 400);
});

test('更新網站：換成私網的 target_origin 也要過 SSRF 檢查', async (t) => {
  const { post, put } = await arrange(t, { config: { allowPrivate: false } });
  await post('/admin/api/sites', EXAMPLE);

  const response = await put('/admin/api/sites/example', { target_origin: 'http://10.0.0.5' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'ssrf_blocked');
});

test('刪除網站：204，再刪一次 404', async (t) => {
  const { post, del } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  assert.equal((await del('/admin/api/sites/example')).status, 204);
  assert.equal((await del('/admin/api/sites/example')).status, 404);
});

test('刪除網站會連帶刪掉腳本', async (t) => {
  const { post, del, call } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);
  const created = await post('/admin/api/sites/example/scripts', { name: 'a', code: 'x' });

  await del('/admin/api/sites/example');

  assert.equal((await call(`/admin/api/scripts/${created.body.script.id}`)).status, 404);
});

test('建立腳本：預設值 + 201', async (t) => {
  const { post } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  const response = await post('/admin/api/sites/example/scripts', {
    name: '換標題',
    code: "document.title = 'x'",
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.script.site_id, 'example');
  assert.equal(response.body.script.match_glob, '*');
  assert.equal(response.body.script.run_at, 'body-end');
  assert.equal(response.body.script.order_index, 0);
  assert.equal(response.body.script.enabled, true);
});

test('建立腳本：網站不存在 → 404', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/sites/ghost/scripts', { name: 'a', code: 'x' });
  assert.equal(response.status, 404);
});

test('建立腳本：run_at 亂填 / code 空 / code 超過 1MB → 400', async (t) => {
  const { post } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);

  const badRunAt = await post('/admin/api/sites/example/scripts', {
    name: 'a',
    code: 'x',
    run_at: 'document-start',
  });
  assert.equal(badRunAt.status, 400);

  const emptyCode = await post('/admin/api/sites/example/scripts', { name: 'a', code: '' });
  assert.equal(emptyCode.status, 400);

  const tooBig = await post('/admin/api/sites/example/scripts', {
    name: 'a',
    code: 'x'.repeat(MAX_CODE_BYTES + 10),
  });
  assert.equal(tooBig.status, 400);
  assert.ok(tooBig.body.details.some((detail) => detail.field === 'code'));
});

test('列出某網站的腳本：依 order_index 排序', async (t) => {
  const { post, call } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);
  await post('/admin/api/sites/example/scripts', { name: 'b', code: 'x', order_index: 2 });
  await post('/admin/api/sites/example/scripts', { name: 'a', code: 'x', order_index: 1 });

  const response = await call('/admin/api/sites/example/scripts');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.scripts.map((script) => script.name),
    ['a', 'b'],
  );
});

test('列出腳本：網站不存在 → 404', async (t) => {
  const { call } = await arrange(t);
  assert.equal((await call('/admin/api/sites/ghost/scripts')).status, 404);
});

test('讀 / 改 / 刪單一腳本', async (t) => {
  const { post, put, del, call } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);
  const created = await post('/admin/api/sites/example/scripts', { name: 'a', code: 'x' });
  const { id } = created.body.script;

  assert.equal((await call(`/admin/api/scripts/${id}`)).status, 200);

  const updated = await put(`/admin/api/scripts/${id}`, {
    code: 'y',
    run_at: 'head-end',
    enabled: false,
    order_index: 5,
    match_glob: '/shop/**',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.script.code, 'y');
  assert.equal(updated.body.script.run_at, 'head-end');
  assert.equal(updated.body.script.enabled, false);
  assert.equal(updated.body.script.order_index, 5);
  assert.equal(updated.body.script.match_glob, '/shop/**');

  assert.equal((await del(`/admin/api/scripts/${id}`)).status, 204);
  assert.equal((await call(`/admin/api/scripts/${id}`)).status, 404);
});

test('改腳本：不存在 404、空 body 400、想改 site_id 400', async (t) => {
  const { post, put } = await arrange(t);
  await post('/admin/api/sites', EXAMPLE);
  const created = await post('/admin/api/sites/example/scripts', { name: 'a', code: 'x' });
  const { id } = created.body.script;

  assert.equal((await put('/admin/api/scripts/scr_ghost', { code: 'x' })).status, 404);
  assert.equal((await put(`/admin/api/scripts/${id}`, {})).status, 400);
  assert.equal((await put(`/admin/api/scripts/${id}`, { site_id: 'other' })).status, 400);
});

test('壞掉的 JSON body → 400，不是 500', async (t) => {
  const { app } = await arrange(t);

  const response = await fetch(`${app.base}/admin/api/sites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
    },
    body: '{ not json',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('未知的後台 API 路徑 → 404 JSON', async (t) => {
  const { call } = await arrange(t);

  const response = await call('/admin/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});
