'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSiteCreate,
  validateSiteUpdate,
  validateScriptCreate,
  validateScriptUpdate,
  MAX_CODE_BYTES,
} = require('../../src/lib/validate.js');

const okSite = { id: 'example', name: 'Example', target_origin: 'https://example.com' };

test('site 建立：正常輸入通過並正規化 origin', () => {
  const result = validateSiteCreate({ ...okSite, target_origin: 'https://example.com/' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    id: 'example',
    name: 'Example',
    target_origin: 'https://example.com',
    enabled: 1,
  });
});

test('site 建立：slug 格式', () => {
  for (const id of ['A-bad', 'has space', 'under_score', '', 'a'.repeat(41), 'bang!']) {
    const result = validateSiteCreate({ ...okSite, id });
    assert.equal(result.ok, false, `應該要拒絕 ${JSON.stringify(id)}`);
    assert.ok(result.errors.some((e) => e.field === 'id'), 'error 要指向 id');
  }
  assert.equal(validateSiteCreate({ ...okSite, id: 'a' }).ok, true);
  assert.equal(validateSiteCreate({ ...okSite, id: 'a'.repeat(40) }).ok, true);
  assert.equal(validateSiteCreate({ ...okSite, id: 'my-site-2' }).ok, true);
});

test('site 建立：保留字不准當 slug', () => {
  for (const id of ['admin', 'p', '__lm']) {
    const result = validateSiteCreate({ ...okSite, id });
    assert.equal(result.ok, false, `${id} 應該被保留`);
  }
});

test('site 建立：target_origin 必須是乾淨的 http(s) origin', () => {
  const bad = [
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'example.com',
    'https://example.com/path',
    'https://example.com/?a=1',
    'https://user:pw@example.com',
    '',
    'https://',
  ];
  for (const target_origin of bad) {
    const result = validateSiteCreate({ ...okSite, target_origin });
    assert.equal(result.ok, false, `應該要拒絕 ${JSON.stringify(target_origin)}`);
    assert.ok(result.errors.some((e) => e.field === 'target_origin'));
  }
});

test('site 建立：http 與自訂 port 可以', () => {
  const result = validateSiteCreate({ ...okSite, target_origin: 'http://localhost:3000' });
  assert.equal(result.ok, true);
  assert.equal(result.value.target_origin, 'http://localhost:3000');
});

test('site 建立：name 必填、會 trim、有長度上限', () => {
  assert.equal(validateSiteCreate({ ...okSite, name: '   ' }).ok, false);
  assert.equal(validateSiteCreate({ ...okSite, name: 'a'.repeat(121) }).ok, false);
  assert.equal(validateSiteCreate({ ...okSite, name: '  Hi  ' }).value.name, 'Hi');
});

test('site 建立：enabled 接受 boolean / 0 / 1，預設 1', () => {
  assert.equal(validateSiteCreate({ ...okSite, enabled: false }).value.enabled, 0);
  assert.equal(validateSiteCreate({ ...okSite, enabled: 0 }).value.enabled, 0);
  assert.equal(validateSiteCreate({ ...okSite, enabled: true }).value.enabled, 1);
  assert.equal(validateSiteCreate(okSite).value.enabled, 1);
  assert.equal(validateSiteCreate({ ...okSite, enabled: 'yes' }).ok, false);
});

test('site 建立：非物件輸入被拒', () => {
  assert.equal(validateSiteCreate(null).ok, false);
  assert.equal(validateSiteCreate('nope').ok, false);
});

test('site 更新：部分欄位、不准改 id', () => {
  const result = validateSiteUpdate({ name: 'New name' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: 'New name' });

  const withId = validateSiteUpdate({ id: 'other', name: 'x' });
  assert.equal(withId.ok, false);
  assert.ok(withId.errors.some((e) => e.field === 'id'));

  assert.equal(validateSiteUpdate({}).ok, false, '空的更新沒有意義');
});

test('script 建立：預設值', () => {
  const result = validateScriptCreate({ name: 'hide ads', code: 'console.info(1)' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    name: 'hide ads',
    code: 'console.info(1)',
    enabled: 1,
    match_glob: '*',
    run_at: 'body-end',
    order_index: 0,
  });
});

test('script 建立：run_at 只收兩個值', () => {
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', run_at: 'head-end' }).ok, true);
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', run_at: 'body-end' }).ok, true);
  const bad = validateScriptCreate({ name: 'a', code: 'x', run_at: 'document-start' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.field === 'run_at'));
});

test('script 建立：code 必填且有 1MB 上限', () => {
  assert.equal(validateScriptCreate({ name: 'a', code: '' }).ok, false);
  assert.equal(MAX_CODE_BYTES, 1024 * 1024);
  const tooBig = validateScriptCreate({ name: 'a', code: 'x'.repeat(MAX_CODE_BYTES + 1) });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.errors.some((e) => e.field === 'code'));
  assert.equal(validateScriptCreate({ name: 'a', code: 'x'.repeat(MAX_CODE_BYTES) }).ok, true);
});

test('script 建立：order_index 必須是整數', () => {
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', order_index: 3 }).value.order_index, 3);
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', order_index: 1.5 }).ok, false);
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', order_index: 'first' }).ok, false);
});

test('script 建立：match_glob 不准換行、有長度上限', () => {
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', match_glob: '/shop/**' }).ok, true);
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', match_glob: 'a\nb' }).ok, false);
  assert.equal(validateScriptCreate({ name: 'a', code: 'x', match_glob: '' }).ok, false);
  assert.equal(
    validateScriptCreate({ name: 'a', code: 'x', match_glob: 'a'.repeat(201) }).ok,
    false,
  );
});

test('script 更新：部分欄位、空物件被拒、site_id 不准改', () => {
  assert.deepEqual(validateScriptUpdate({ enabled: false }).value, { enabled: 0 });
  assert.equal(validateScriptUpdate({}).ok, false);
  assert.equal(validateScriptUpdate({ site_id: 'other' }).ok, false);
});

test('錯誤訊息是人看得懂的字串，而且每個 error 都有 field', () => {
  const result = validateSiteCreate({ id: 'BAD', name: '', target_origin: 'nope' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
  for (const err of result.errors) {
    assert.equal(typeof err.field, 'string');
    assert.ok(err.message.length > 0);
  }
});
