'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findHardcodedSecrets,
  warnOnHardcodedSecrets,
  MIN_LENGTH,
  SOURCE_DIR,
} = require('../../src/admin/secret-scan.js');

/**
 * 啟動時的「金鑰有沒有被寫進程式碼」檢查（SPEC-checkout §0.1）。
 *
 * ⛔ 這支最重要的一條是**零誤報**：一個每次啟動都在喊狼來了的警告，
 * 等於把真正中招的那一次也一起消音。所以它只比對「env 裡那個確切的值」，
 * 不做任何「這串看起來像金鑰」的猜測。
 */

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-scan-'));

  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  return dir;
}

function collectingLogger() {
  const warned = [];
  return { warned, logger: { info: () => {}, warn: (line) => warned.push(line) } };
}

test('金鑰被貼進原始碼就抓得到', () => {
  const secret = 'a'.repeat(32);
  const dir = scratch({ 'reskin/oops.js': `const key = '${secret}';\n` });

  assert.deepEqual(findHardcodedSecrets({ LOCALMONKEY_NEWEBPAY_HASH_KEY: secret }, { dir }), [
    { name: 'LOCALMONKEY_NEWEBPAY_HASH_KEY', file: path.join('reskin', 'oops.js') },
  ]);
});

test('乾淨的原始碼一句話都不說', () => {
  const dir = scratch({ 'clean.js': "const key = process.env.LOCALMONKEY_NEWEBPAY_HASH_KEY;\n" });

  assert.deepEqual(findHardcodedSecrets({ LOCALMONKEY_NEWEBPAY_HASH_KEY: 'b'.repeat(32) }, { dir }), []);
});

test('沒設金鑰就整個不掃（示範模式不該有任何噪音）', () => {
  const dir = scratch({ 'x.js': 'whatever\n' });

  assert.deepEqual(
    findHardcodedSecrets({ A: null, B: undefined, C: '' }, { dir }),
    [],
  );
});

/**
 * ⛔ 太短的值不掃。一個 8 個字的商店代號有可能剛好是某個檔案裡的普通字串，
 * 而那種誤報會訓練人忽略這個警告。真正的祕密都夠長（HashKey 32 / HashIV 16）。
 */
test('太短的值不掃（誤報比漏報更傷）', () => {
  const short = 'x'.repeat(MIN_LENGTH - 1);
  const dir = scratch({ 'x.js': `const v = '${short}';\n` });

  assert.deepEqual(findHardcodedSecrets({ SOMETHING: short }, { dir }), []);
});

test('vendor / node_modules 不掃（那不是我們寫的）', () => {
  const secret = 'c'.repeat(32);
  const dir = scratch({
    'public/vendor/thing.js': `${secret}\n`,
    'node_modules/pkg/index.js': `${secret}\n`,
  });

  assert.deepEqual(findHardcodedSecrets({ K: secret }, { dir }), []);
});

test('只掃我們自己那幾種副檔名', () => {
  const secret = 'd'.repeat(32);
  const dir = scratch({ 'notes.md': `${secret}\n`, 'data.bin': `${secret}\n` });

  assert.deepEqual(findHardcodedSecrets({ K: secret }, { dir }), []);
});

/** ⛔ 警告裡不准印出金鑰本身 —— 印了就等於把它寫進 log，而那正是這支在防的事。 */
test('⛔ 警告訊息裡沒有金鑰的值', () => {
  const secret = 'e'.repeat(32);
  const dir = scratch({ 'bad.js': `${secret}\n` });
  const { warned, logger } = collectingLogger();

  assert.equal(warnOnHardcodedSecrets({ logger, secrets: { K: secret }, dir }), 1);
  assert.equal(warned.length, 1);
  assert.ok(!warned[0].includes(secret), warned[0]);
  assert.match(warned[0], /bad\.js/);
  assert.match(warned[0], /輪替/, '抓到之後要叫人換金鑰，不只是刪掉');
});

test('掃不動的時候不准讓服務起不來', () => {
  const { warned, logger } = collectingLogger();

  assert.equal(
    warnOnHardcodedSecrets({
      logger,
      secrets: { K: 'f'.repeat(32) },
      dir: path.join(os.tmpdir(), 'lm-scan-does-not-exist-9f3a'),
    }),
    0,
  );
  assert.equal(warned.length, 1);
  assert.match(warned[0], /不影響服務/);
});

/**
 * ⛔ 真正的回歸測試：**這個 repo 自己是乾淨的。**
 *
 * 用一組假的「金鑰」跑一次真的 `src/`，確認掃描器在真實目錄上跑得動
 * 而且不亂叫。同時也確認 `src/` 底下沒有任何東西長得像那幾個常見的
 * 預設值 —— 規格 §0.1 的原話是「程式碼只從 env 讀，不准有任何預設值、
 * 不准有範例金鑰」。
 */
test('這個 repo 的 src/ 沒有硬編的金鑰', () => {
  assert.deepEqual(
    findHardcodedSecrets({
      FAKE_KEY: 'this-value-does-not-appear-anywhere-0123456789',
      FAKE_IV: 'neither-does-this-one-abcdefghijklmnop',
    }),
    [],
  );

  // 掃描器真的有在讀檔（不是因為目錄空的才回空陣列）
  const marker = fs
    .readFileSync(path.join(SOURCE_DIR, 'reskin', 'newebpay.js'), 'utf8')
    .match(/const ORDER_PREFIX = '(\w+)'/);
  assert.ok(marker, '找不到比對用的錨點，是不是路徑錯了？');

  assert.deepEqual(
    findHardcodedSecrets({ ANCHOR: "const ORDER_PREFIX = 'HTK'" }),
    [{ name: 'ANCHOR', file: path.join('reskin', 'newebpay.js') }],
  );
});
