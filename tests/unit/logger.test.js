'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLogger, silentLogger, LEVELS } = require('../../src/logger.js');

function fakeStream() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test('info 進 stdout，warn 與 error 進 stderr', () => {
  const out = fakeStream();
  const err = fakeStream();
  const logger = createLogger({ out, err });

  logger.info('起來了');
  logger.warn('怪怪的');
  logger.error('壞了');

  assert.equal(out.lines.length, 1);
  assert.equal(err.lines.length, 2);
  assert.match(out.lines[0], /^\d{4}-\d{2}-\d{2}T.*\[info \] 起來了\n$/);
  assert.match(err.lines[0], /\[warn \] 怪怪的/);
  assert.match(err.lines[1], /\[error\] 壞了/);
});

test('level 控制要不要寫出來', () => {
  const out = fakeStream();
  const err = fakeStream();
  const logger = createLogger({ level: 'error', out, err });

  logger.info('不該出現');
  logger.warn('也不該出現');
  logger.debug('更不該');
  logger.error('只有這個');

  assert.equal(out.lines.length, 0);
  assert.equal(err.lines.length, 1);
});

test('debug 只在 level=debug 時出現', () => {
  const out = fakeStream();
  createLogger({ level: 'debug', out, err: fakeStream() }).debug('細節');
  assert.equal(out.lines.length, 1);
});

test('認不得的 level 退回 info', () => {
  const out = fakeStream();
  createLogger({ level: 'nonsense', out, err: fakeStream() }).info('x');
  assert.equal(out.lines.length, 1);
});

test('Error 物件被印成「名稱: 訊息」，不是 {}', () => {
  const err = fakeStream();
  createLogger({ out: fakeStream(), err }).error('失敗', new TypeError('壞了'));
  assert.match(err.lines[0], /TypeError: 壞了/);
});

test('物件被 JSON 化，循環參照不會爆', () => {
  const out = fakeStream();
  const logger = createLogger({ out, err: fakeStream() });

  logger.info('資料', { a: 1 });
  assert.match(out.lines[0], /\{"a":1\}/);

  const circular = { self: null };
  circular.self = circular;
  assert.doesNotThrow(() => logger.info('循環', circular));
});

test('silentLogger 什麼都不做（測試用）', () => {
  assert.doesNotThrow(() => {
    silentLogger.info('x');
    silentLogger.warn('x');
    silentLogger.error('x');
    silentLogger.debug('x');
  });
  assert.equal(LEVELS.silent, 0);
});
