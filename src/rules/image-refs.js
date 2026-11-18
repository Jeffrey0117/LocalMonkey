'use strict';

/**
 * 「這個站載過哪些圖」（SPEC-rules §3.6 的候選清單）。
 *
 * 規格明說**不要逼使用者自己開 DevTools 抄路徑** —— 所以控制台要能列出候選、
 * 點一下就換。這支是那份清單的來源：掃一份上游 HTML，收 `<img src>`、
 * `srcset`、以及 CSS 的 `url()`。
 *
 * ⛔ `url()` 一定要收：換 logo 最常漏掉的就是 `background-image`（DOM 改
 * `img.src` 的做法完全碰不到它，那也是覆寫做在請求層的理由之一）。
 *
 * 跟專案裡其他 HTML 處理一樣是保守的正則掃描，不引入 parser。
 */

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.svg',
]);

const SRC_PATTERN = /<(?:img|source|input)\b[^>]*?\ssrc\s*=\s*("[^"]*"|'[^']*')/gi;
const SRCSET_PATTERN = /\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi;
const URL_FUNCTION_PATTERN = /url\(\s*("[^"]*"|'[^']*'|[^)'"\s]+)\s*\)/gi;

function unquote(value) {
  const trimmed = value.trim();
  return /^["']/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

function extensionOf(path) {
  const at = path.lastIndexOf('.');
  return at === -1 ? '' : path.slice(at).toLowerCase();
}

/**
 * 候選網址 → 這個站的路徑（不是這個站的就回 null）。
 *
 * 比對用 `origin` 的整個字串：`//cdn.other.test/x` 這種 protocol-relative
 * 一律當跨網域（跟 `lib/html.js` 的根路徑改寫同一個判準）。
 */
function toSitePath(value, origin) {
  if (value.length === 0 || value.startsWith('data:') || value.startsWith('//')) return null;

  const path = value.startsWith('/')
    ? value
    : value.startsWith(`${origin}/`)
      ? value.slice(origin.length)
      : null;

  if (path === null) return null;

  const clean = path.split(/[?#]/)[0];
  return IMAGE_EXTENSIONS.has(extensionOf(clean)) ? clean : null;
}

function matchesOf(html, pattern) {
  pattern.lastIndex = 0;
  return [...html.matchAll(pattern)].map((matched) => unquote(matched[1]));
}

/**
 * @param {string} html 上游的 HTML（**不是**代理改寫過的那份 —— 路徑要是原始的）
 * @param {{ origin?: string }} options
 * @returns {Array<{ path: string, count: number }>} 出現次數多的排前面
 */
function collectImageRefs(html, { origin } = {}) {
  if (typeof html !== 'string' || typeof origin !== 'string' || origin.length === 0) return [];

  const candidates = [
    ...matchesOf(html, SRC_PATTERN),
    ...matchesOf(html, SRCSET_PATTERN).flatMap((value) =>
      value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? ''),
    ),
    ...matchesOf(html, URL_FUNCTION_PATTERN),
  ];

  const counted = candidates.reduce((acc, value) => {
    const path = toSitePath(value, origin);
    if (path === null) return acc;
    return acc.set(path, (acc.get(path) ?? 0) + 1);
  }, new Map());

  return [...counted.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
}

module.exports = { collectImageRefs, IMAGE_EXTENSIONS };
