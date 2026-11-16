'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  planInjection,
  scriptUrl,
  shimUrl,
  assetUrl,
} = require('../../src/lib/injection.js');

function row(overrides = {}) {
  return {
    id: 'scr_a',
    name: 'a',
    run_at: 'document-end',
    metadata: { needsShim: false, requireAssets: [] },
    order_index: 0,
    path_glob: '*',
    exclude_globs: [],
    ...overrides,
  };
}

function sources(entries) {
  return entries.map((entry) => entry.src);
}

test('路徑符合 → 注入；不符合 → 不注入', () => {
  const matched = planInjection([row({ path_glob: '/shop/**' })], { pathname: '/shop/42' });
  const missed = planInjection([row({ path_glob: '/shop/**' })], { pathname: '/' });

  assert.deepEqual(sources(matched.body), [scriptUrl('scr_a')]);
  assert.deepEqual(missed.body, []);
});

test('run_at 決定注入位置：document-start → headStart', () => {
  const plan = planInjection([row({ run_at: 'document-start' })], { pathname: '/' });

  assert.deepEqual(sources(plan.headStart), [scriptUrl('scr_a')]);
  assert.deepEqual(plan.head, []);
  assert.deepEqual(plan.body, []);
});

test('run_at document-end 與 document-idle 都在 body 結尾', () => {
  for (const runAt of ['document-end', 'document-idle']) {
    const plan = planInjection([row({ run_at: runAt })], { pathname: '/' });
    assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')], runAt);
  }
});

test('v1 的 head-end / body-end 維持 v1 的位置（相容層）', () => {
  const headEnd = planInjection([row({ run_at: 'head-end' })], { pathname: '/' });
  assert.deepEqual(sources(headEnd.head), [scriptUrl('scr_a')]);
  assert.deepEqual(headEnd.headStart, [], 'head-end 不該被升級成 document-start');

  const bodyEnd = planInjection([row({ run_at: 'body-end' })], { pathname: '/' });
  assert.deepEqual(sources(bodyEnd.body), [scriptUrl('scr_a')]);
});

test('認不出來的 run_at 退到 body 結尾（最保守的位置）', () => {
  const plan = planInjection([row({ run_at: '???' })], { pathname: '/' });
  assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')]);
});

test('@exclude 命中就不注入（排除優先於配對）', () => {
  const plan = planInjection(
    [row({ path_glob: '*', exclude_globs: ['/admin/**'] })],
    { pathname: '/admin/users' },
  );

  assert.deepEqual(plan.body, []);
});

test('@exclude 沒命中就照注入', () => {
  const plan = planInjection(
    [row({ path_glob: '*', exclude_globs: ['/admin/**'] })],
    { pathname: '/shop' },
  );

  assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')]);
});

test('多條 exclude 任一命中就不注入', () => {
  const plan = planInjection(
    [row({ exclude_globs: ['/admin/**', '/login'] })],
    { pathname: '/login' },
  );

  assert.deepEqual(plan.body, []);
});

test('同一支腳本有多個綁定都命中 → 只注入一次', () => {
  const plan = planInjection(
    [row({ path_glob: '*' }), row({ path_glob: '/shop/**' })],
    { pathname: '/shop/1' },
  );

  assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')]);
});

test('第一個綁定沒命中、第二個命中 → 還是注入得到', () => {
  const plan = planInjection(
    [row({ path_glob: '/user/**' }), row({ path_glob: '/shop/**' })],
    { pathname: '/shop/1' },
  );

  assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')]);
});

test('needsShim → shim 排在使用者腳本之前', () => {
  const plan = planInjection(
    [row({ metadata: { needsShim: true, requireAssets: [] } })],
    { pathname: '/' },
  );

  assert.deepEqual(sources(plan.body), [shimUrl('scr_a'), scriptUrl('scr_a')]);
});

test('@require 的資產排在 shim 之後、使用者腳本之前，照宣告順序', () => {
  const plan = planInjection(
    [
      row({
        metadata: {
          needsShim: true,
          requireAssets: [
            { url: 'https://cdn.test/a.js', sha256: 'a'.repeat(64) },
            { url: 'https://cdn.test/b.js', sha256: 'b'.repeat(64) },
          ],
        },
      }),
    ],
    { pathname: '/' },
  );

  assert.deepEqual(sources(plan.body), [
    shimUrl('scr_a'),
    assetUrl('a'.repeat(64)),
    assetUrl('b'.repeat(64)),
    scriptUrl('scr_a'),
  ]);
});

test('抓失敗的 @require（沒有 sha256）會被跳過，但腳本本身照注入', () => {
  const plan = planInjection(
    [
      row({
        metadata: {
          needsShim: false,
          requireAssets: [{ url: 'https://cdn.test/dead.js', sha256: null, error: 'fetch failed' }],
        },
      }),
    ],
    { pathname: '/' },
  );

  assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')]);
});

test('metadata 壞掉 / 缺欄位也不會讓注入整個掛掉', () => {
  for (const metadata of [undefined, null, {}, { requireAssets: 'not-an-array' }]) {
    const plan = planInjection([row({ metadata })], { pathname: '/' });
    assert.deepEqual(sources(plan.body), [scriptUrl('scr_a')], JSON.stringify(metadata));
  }
});

test('多支腳本照傳進來的順序注入（呼叫端已依 order_index 排好）', () => {
  const plan = planInjection(
    [
      row({ id: 'scr_first', order_index: 1 }),
      row({ id: 'scr_second', order_index: 2 }),
    ],
    { pathname: '/' },
  );

  assert.deepEqual(sources(plan.body), [scriptUrl('scr_first'), scriptUrl('scr_second')]);
});

test('不同 run_at 的腳本各進各的位置', () => {
  const plan = planInjection(
    [
      row({ id: 'scr_early', run_at: 'document-start' }),
      row({ id: 'scr_late', run_at: 'document-end' }),
    ],
    { pathname: '/' },
  );

  assert.deepEqual(sources(plan.headStart), [scriptUrl('scr_early')]);
  assert.deepEqual(sources(plan.body), [scriptUrl('scr_late')]);
});

test('沒有腳本 → 三個桶子都是空的', () => {
  const plan = planInjection([], { pathname: '/' });
  assert.deepEqual(plan, { headStart: [], head: [], body: [] });
});

test('非陣列輸入不會炸', () => {
  assert.deepEqual(planInjection(null, { pathname: '/' }), { headStart: [], head: [], body: [] });
});

test('投遞網址都在 /__lm/ 底下（保留路徑，不會被當成代理資源）', () => {
  assert.equal(scriptUrl('scr_a'), '/__lm/script/scr_a.js');
  assert.equal(shimUrl('scr_a'), '/__lm/shim/scr_a.js');
  assert.equal(assetUrl('c'.repeat(64)), `/__lm/asset/${'c'.repeat(64)}.js`);
});

test('id 會被 URL 編碼（不要讓奇怪的 id 跑出路徑）', () => {
  assert.equal(scriptUrl('a/b'), '/__lm/script/a%2Fb.js');
});
