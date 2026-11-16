'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ensureAdminToken, TOKEN_FILENAME } = require('../../src/admin/token.js');
const { tokensMatch } = require('../../src/admin/compare.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-token-'));
}

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

test('env 有設就用 env，不寫檔案', () => {
  const dataDir = tempDir();
  const result = ensureAdminToken({ envToken: 'env-token', dataDir, logger: quietLogger });
  assert.equal(result.token, 'env-token');
  assert.equal(result.source, 'env');
  assert.equal(fs.existsSync(path.join(dataDir, TOKEN_FILENAME)), false);
});

test('沒設 env：產生 32 bytes 隨機 hex、寫檔、印出來', () => {
  const dataDir = tempDir();
  const logged = [];
  const result = ensureAdminToken({
    envToken: null,
    dataDir,
    logger: { ...quietLogger, info: (msg) => logged.push(String(msg)) },
  });

  assert.equal(result.source, 'generated');
  assert.match(result.token, /^[0-9a-f]{64}$/);
  const onDisk = fs.readFileSync(path.join(dataDir, TOKEN_FILENAME), 'utf8').trim();
  assert.equal(onDisk, result.token);
  assert.ok(
    logged.some((line) => line.includes(result.token)),
    '第一次產生時要印在 log 讓使用者拿得到',
  );
});

test('第二次啟動讀既有檔案，token 不變', () => {
  const dataDir = tempDir();
  const first = ensureAdminToken({ envToken: null, dataDir, logger: quietLogger });
  const second = ensureAdminToken({ envToken: null, dataDir, logger: quietLogger });
  assert.equal(second.token, first.token);
  assert.equal(second.source, 'file');
});

test('每次產生的 token 都不一樣', () => {
  const a = ensureAdminToken({ envToken: null, dataDir: tempDir(), logger: quietLogger });
  const b = ensureAdminToken({ envToken: null, dataDir: tempDir(), logger: quietLogger });
  assert.notEqual(a.token, b.token);
});

test('檔案裡的空白被 trim 掉', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, TOKEN_FILENAME), '  abc123\n\n', 'utf8');
  const result = ensureAdminToken({ envToken: null, dataDir, logger: quietLogger });
  assert.equal(result.token, 'abc123');
});

test('檔案是空的 → 重新產生，不是回空字串', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, TOKEN_FILENAME), '   \n', 'utf8');
  const result = ensureAdminToken({ envToken: null, dataDir, logger: quietLogger });
  assert.equal(result.source, 'generated');
  assert.match(result.token, /^[0-9a-f]{64}$/);
});

test('資料目錄不存在時自己建', () => {
  const dataDir = path.join(tempDir(), 'nested', 'deeper');
  const result = ensureAdminToken({ envToken: null, dataDir, logger: quietLogger });
  assert.equal(fs.existsSync(path.join(dataDir, TOKEN_FILENAME)), true);
  assert.match(result.token, /^[0-9a-f]{64}$/);
});

test('tokensMatch 用 crypto.timingSafeEqual 比對', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    assert.equal(tokensMatch('abcdef', 'abcdef'), true);
    assert.ok(spy.mock.callCount() > 0, '必須真的呼叫 timingSafeEqual');
  } finally {
    spy.mock.restore();
  }
});

test('tokensMatch：長度不同先擋掉，不呼叫 timingSafeEqual（它會丟錯）', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    assert.equal(tokensMatch('short', 'muchlongertoken'), false);
    assert.equal(spy.mock.callCount(), 0);
  } finally {
    spy.mock.restore();
  }
});

test('tokensMatch：不同內容、空值、非字串都是 false', () => {
  assert.equal(tokensMatch('aaaaaa', 'bbbbbb'), false);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch('abc', null), false);
  assert.equal(tokensMatch(undefined, 'abc'), false);
  assert.equal(tokensMatch(123456, 123456), false);
});
