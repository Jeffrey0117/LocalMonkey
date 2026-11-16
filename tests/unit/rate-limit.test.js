'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, MAX_TRACKED_KEYS } = require('../../src/lib/rate-limit.js');

/** 可控時鐘：速率限制一定要能在不等真實時間的情況下測 */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('額度內放行，超過就擋', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: clock.now });

  assert.equal(limiter.check('site-a').allowed, true);
  assert.equal(limiter.check('site-a').allowed, true);
  assert.equal(limiter.check('site-a').allowed, true);

  const blocked = limiter.check('site-a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000, `retryAfterMs=${blocked.retryAfterMs}`);
});

test('時間窗滑過去就恢復', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: clock.now });

  limiter.check('site-a');
  limiter.check('site-a');
  assert.equal(limiter.check('site-a').allowed, false);

  clock.advance(1001);
  assert.equal(limiter.check('site-a').allowed, true);
});

test('時間窗是滑動的，不是整段歸零', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: clock.now });

  limiter.check('site-a'); // t=0
  clock.advance(600);
  limiter.check('site-a'); // t=600
  assert.equal(limiter.check('site-a').allowed, false, 't=600 時窗內已經有兩筆');

  clock.advance(500); // t=1100：第一筆（t=0）滑出窗外
  assert.equal(limiter.check('site-a').allowed, true);
  assert.equal(limiter.check('site-a').allowed, false, 't=600 的那筆還在窗內');
});

test('不同 key 各算各的', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

  assert.equal(limiter.check('site-a').allowed, true);
  assert.equal(limiter.check('site-b').allowed, true);
  assert.equal(limiter.check('site-a').allowed, false);
  assert.equal(limiter.check('site-b').allowed, false);
});

test('remaining 會回報還剩幾次', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: clock.now });

  assert.equal(limiter.check('site-a').remaining, 2);
  assert.equal(limiter.check('site-a').remaining, 1);
  assert.equal(limiter.check('site-a').remaining, 0);
  assert.equal(limiter.check('site-a').remaining, 0);
});

test('key 數量有上限（不要讓記憶體無限長大）', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

  for (let index = 0; index < MAX_TRACKED_KEYS + 50; index += 1) {
    limiter.check(`site-${index}`);
  }

  assert.ok(limiter.size() <= MAX_TRACKED_KEYS, `size=${limiter.size()}`);
  // 最新的 key 一定還在被追蹤（舊的先被淘汰）
  assert.equal(limiter.check(`site-${MAX_TRACKED_KEYS + 49}`).allowed, false);
});

test('過期的 key 會被清掉', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

  limiter.check('site-a');
  assert.equal(limiter.size(), 1);

  clock.advance(5000);
  limiter.check('site-b');

  assert.equal(limiter.size(), 1, '過期的 site-a 應該被清掉');
});

test('limit 設 0 或負數 → 一律擋（fail closed，不要變成無限放行）', () => {
  const limiter = createRateLimiter({ limit: 0, windowMs: 1000 });
  assert.equal(limiter.check('x').allowed, false);
});

test('預設用真實時鐘也能跑', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.check('x').allowed, true);
  assert.equal(limiter.check('x').allowed, false);
});
