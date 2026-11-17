'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scriptFeatures } = require('../../src/lib/script-features.js');

/** 後台列表「功能」欄的旗標。純函式，所以每個分支都測得到。 */

test('空的 metadata：每一格都是安全的預設值，不會 undefined', () => {
  assert.deepEqual(scriptFeatures(), {
    requires: 0,
    resources: 0,
    grants: 0,
    unsupportedGrants: [],
    needsShim: false,
    delivery: false,
  });
});

test('@require / @resource / @grant 的數量', () => {
  const features = scriptFeatures({
    metadata: {
      requires: ['https://a.test/1.js', 'https://a.test/2.js'],
      resources: [{ name: 'css', url: 'https://a.test/x.css' }],
      canonicalGrants: ['GM_setValue', 'GM_getValue', 'GM_addStyle'],
      needsShim: true,
    },
  });

  assert.equal(features.requires, 2);
  assert.equal(features.resources, 1);
  assert.equal(features.grants, 3);
  assert.equal(features.needsShim, true);
});

test('沒有 canonicalGrants 就退回 grants（舊資料相容）', () => {
  assert.equal(scriptFeatures({ metadata: { grants: ['GM_setValue'] } }).grants, 1);
});

test('未支援的 @grant 照實回報（UI 要標紅並說明是哪一個）', () => {
  const features = scriptFeatures({ metadata: { unsupportedGrants: ['GM_cookie'] } });
  assert.deepEqual(features.unsupportedGrants, ['GM_cookie']);
});

test('unsupportedGrants 裡的非字串會被濾掉（壞資料不該弄爆 UI）', () => {
  const features = scriptFeatures({ metadata: { unsupportedGrants: ['GM_cookie', 42, null] } });
  assert.deepEqual(features.unsupportedGrants, ['GM_cookie']);
});

test('有 delivery_token 才算有投遞網址', () => {
  assert.equal(scriptFeatures({ deliveryToken: 'a'.repeat(64) }).delivery, true);
  assert.equal(scriptFeatures({ deliveryToken: '' }).delivery, false);
  assert.equal(scriptFeatures({ deliveryToken: null }).delivery, false);
});

test('metadata 不是物件、陣列欄位不是陣列 → 一律退回預設，不丟錯', () => {
  assert.equal(scriptFeatures({ metadata: null }).requires, 0);
  assert.equal(scriptFeatures({ metadata: 'nope' }).grants, 0);
  assert.deepEqual(scriptFeatures({ metadata: { unsupportedGrants: 'GM_cookie' } }).unsupportedGrants, []);
});
