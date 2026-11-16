'use strict';

/**
 * 極簡滑動視窗速率限制。給 `/__lm/gm/xhr` 用（每個站各算各的）。
 *
 * 記在記憶體裡就夠：這是單程序的自架工具，重啟後歸零是可接受的。
 * 但 key 數量要有上限 —— 不然「每個 siteId 一個 entry」會變成沒有邊界的記憶體。
 */

const MAX_TRACKED_KEYS = 500;

/**
 * @param {{ limit: number, windowMs: number, now?: () => number }} options
 */
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();

  function prune(currentTime) {
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((at) => currentTime - at < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  function evictOldest() {
    // Map 的迭代順序就是插入順序 → 第一個是最舊的
    const oldest = hits.keys().next();
    if (!oldest.done) hits.delete(oldest.value);
  }

  return {
    /**
     * @param {string} key
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    check(key) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return { allowed: false, remaining: 0, retryAfterMs: windowMs };
      }

      const currentTime = now();
      prune(currentTime);

      const timestamps = (hits.get(key) ?? []).filter((at) => currentTime - at < windowMs);

      if (timestamps.length >= limit) {
        const retryAfterMs = Math.max(1, windowMs - (currentTime - timestamps[0]));
        hits.set(key, timestamps);
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      if (!hits.has(key) && hits.size >= MAX_TRACKED_KEYS) evictOldest();

      hits.set(key, [...timestamps, currentTime]);

      return {
        allowed: true,
        remaining: Math.max(0, limit - timestamps.length - 1),
        retryAfterMs: 0,
      };
    },

    size() {
      return hits.size;
    },
  };
}

module.exports = { createRateLimiter, MAX_TRACKED_KEYS };
