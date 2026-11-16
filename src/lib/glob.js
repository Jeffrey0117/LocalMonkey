'use strict';

/**
 * 極簡 glob：用來比對「代理後的 path」。
 *
 *   *   一個路徑片段內的任意字元（不跨 /）
 *   **  任意字元，可跨 /
 *   ?   單一個非 / 字元
 *
 * 特例：pattern 剛好是 `*` 時當成 match-all。scripts.match_glob 的預設值是 `*`，
 * 它的語意必須是「所有頁面都跑」，否則預設腳本只會在根目錄生效。
 */

const MAX_PATTERN_LENGTH = 200;
const cache = new Map();

function escapeLiteral(chunk) {
  return chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExpSource(pattern) {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*';
      source += isDoubleStar ? '.*' : '[^/]*';
      index += isDoubleStar ? 2 : 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeLiteral(char);
    index += 1;
  }

  return `^${source}$`;
}

function compile(pattern) {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const regexp = new RegExp(globToRegExpSource(pattern));
  cache.set(pattern, regexp);
  return regexp;
}

function normalizePattern(pattern) {
  return pattern.startsWith('/') ? pattern : `/${pattern}`;
}

/**
 * @param {string} pattern glob pattern
 * @param {string} pathname 代理後的 pathname（不含 query）
 * @returns {boolean}
 */
function matchGlob(pattern, pathname) {
  if (typeof pattern !== 'string' || typeof pathname !== 'string') return false;
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  if (pattern === '*' || pattern === '**') return true;

  const target = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return compile(normalizePattern(pattern)).test(target);
}

module.exports = { matchGlob, MAX_PATTERN_LENGTH };
