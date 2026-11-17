'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PUBLIC_DIR } = require('../../src/routes/admin-page.js');

/**
 * `src/public/format.js` 是瀏覽器端的程式，但裡面是純函式（大小、相對時間、排序），
 * 所以在 vm 裡給一個假 window 就能真的執行它 —— 比對字串測不到
 * 「59 秒要顯示成『剛剛』還是『0 分鐘』」這種事。
 */
function loadFormat() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'format.js'), 'utf8');
  const context = vm.createContext({ window: {} });
  new vm.Script(source).runInContext(context);
  return context.window.LocalMonkeyFormat;
}

const format = loadFormat();

/* ------------------------------ 大小 ------------------------------ */

test('大小格式化成 KB（SPEC：「source 的 byte 數，格式化成 KB」）', () => {
  assert.equal(format.formatBytes(0), '0 B');
  assert.equal(format.formatBytes(512), '0.5 KB');
  assert.equal(format.formatBytes(877), '0.9 KB');
  assert.equal(format.formatBytes(1024), '1.0 KB');
  assert.equal(format.formatBytes(1536), '1.5 KB');
  assert.equal(format.formatBytes(1024 * 1024), '1.0 MB');
});

test('大小是壞資料時不要顯示 NaN', () => {
  assert.equal(format.formatBytes(null), '—');
  assert.equal(format.formatBytes(undefined), '—');
  assert.equal(format.formatBytes('nope'), '—');
  assert.equal(format.formatBytes(-1), '—');
});

/* ---------------------------- 相對時間 ---------------------------- */

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('相對時間：秒 / 分 / 小時 / 天', () => {
  assert.equal(format.relativeTime(ago(5_000), NOW), '剛剛');
  assert.equal(format.relativeTime(ago(2 * 60_000), NOW), '2 分鐘');
  assert.equal(format.relativeTime(ago(3 * 3_600_000), NOW), '3 小時');
  assert.equal(format.relativeTime(ago(9 * 86_400_000), NOW), '9 天');
});

test('相對時間：不滿一分鐘一律「剛剛」，不要出現「0 分鐘」', () => {
  assert.equal(format.relativeTime(ago(59_000), NOW), '剛剛');
  assert.equal(format.relativeTime(ago(60_000), NOW), '1 分鐘');
});

test('相對時間：未來時間（時鐘歪了）也不要變成負數', () => {
  assert.equal(format.relativeTime(new Date(NOW + 60_000).toISOString(), NOW), '剛剛');
});

test('相對時間：壞掉的時間戳回破折號，不要 Invalid Date', () => {
  assert.equal(format.relativeTime(null, NOW), '—');
  assert.equal(format.relativeTime('不是時間', NOW), '—');
});

test('絕對時間給 title 用（相對時間不精確，hover 要看得到原值）', () => {
  assert.equal(typeof format.absoluteTime(ago(0)), 'string');
  assert.ok(format.absoluteTime(ago(0)).includes('2026'));
  assert.equal(format.absoluteTime('不是時間'), '');
});

/* ------------------------------ 排序 ------------------------------ */

const ROWS = [
  { name: 'Banana', version: '1.10.0', size: 300, updatedAt: ago(86_400_000), order_index: 2 },
  { name: 'apple', version: '1.9.0', size: 100, updatedAt: ago(1_000), order_index: 1 },
  { name: 'Cherry', version: null, size: 200, updatedAt: ago(3_600_000), order_index: 3 },
];

// ⚠ sortRows 在 vm context 裡跑，回傳的是**那個 realm 的 Array** → deepEqual 會以
// 「same structure but not reference-equal」失敗（CLAUDE.md 地雷 12）。先轉回宿主的 Array。
const names = (rows) => Array.from(rows).map((row) => row.name);

test('依名稱排序不分大小寫（不然 apple 會被排到最後）', () => {
  assert.deepEqual(names(format.sortRows(ROWS, 'name', 'asc')), ['apple', 'Banana', 'Cherry']);
  assert.deepEqual(names(format.sortRows(ROWS, 'name', 'desc')), ['Cherry', 'Banana', 'apple']);
});

test('版本用數字段比較：1.10.0 比 1.9.0 新（字串比會反過來）', () => {
  const sorted = format.sortRows(ROWS, 'version', 'desc');
  assert.equal(sorted[0].version, '1.10.0');
});

test('沒有版本的排到最後（不管升冪降冪，空值都不該插在中間）', () => {
  assert.equal(format.sortRows(ROWS, 'version', 'asc').at(-1).version, null);
  assert.equal(format.sortRows(ROWS, 'version', 'desc').at(-1).version, null);
});

test('依大小與更新時間排序', () => {
  assert.deepEqual(names(format.sortRows(ROWS, 'size', 'asc')), ['apple', 'Cherry', 'Banana']);
  assert.deepEqual(names(format.sortRows(ROWS, 'updatedAt', 'desc')), ['apple', 'Cherry', 'Banana']);
});

test('依 # 欄（order_index）排序', () => {
  assert.deepEqual(names(format.sortRows(ROWS, 'order_index', 'asc')), ['apple', 'Banana', 'Cherry']);
});

test('⛔ 排序不可以就地改掉傳進來的陣列', () => {
  const input = [...ROWS];
  const before = names(input);

  format.sortRows(input, 'size', 'desc');

  assert.deepEqual(names(input), before, 'sortRows 要回新陣列，不要 mutate');
});

test('不認識的排序欄位：原順序回傳，不要丟錯', () => {
  assert.deepEqual(names(format.sortRows(ROWS, 'nope', 'asc')), names(ROWS));
});
