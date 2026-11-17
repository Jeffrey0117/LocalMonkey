'use strict';

/**
 * 從一頁 HTML 撈出「下一步要爬哪些路徑」（規格 §6）。純函式。
 *
 * 只跟 `<a href>`：`link` / `script` / `img` / `form` 的目標不是「一頁」，
 * 而且 `action` 常常是 POST 端點 —— 爬它們等於對別人的伺服器亂按。
 */

/** 有這些副檔名的一律不是我們要翻的頁面 */
const SKIP_EXTENSIONS = new Set([
  'pdf',
  'zip',
  'rar',
  '7z',
  'gz',
  'tar',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'mp3',
  'mp4',
  'webm',
  'avi',
  'mov',
  'wav',
  'ogg',
  'css',
  'js',
  'mjs',
  'json',
  'xml',
  'rss',
  'txt',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'exe',
  'dmg',
  'apk',
]);

/** 只認被引號包起來的 href（跟 lib/html.js 的政策一致） */
const ANCHOR_HREF = /<a\b[^>]*?\shref\s*=\s*("[^"]*"|'[^']*')/gi;

function extractAnchorHrefs(html) {
  if (typeof html !== 'string') return [];

  return [...html.matchAll(ANCHOR_HREF)].map((match) => match[1].slice(1, -1));
}

function extensionOf(pathname) {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

/**
 * href → 同源的 pathname，不合格的回 null。
 *
 * **丟掉 query 與 hash**（規格 §6）：`?page=2` 與 `#team` 都不是新的一頁，
 * 跟著爬會讓分頁站長出無限多個「新」頁面。
 */
function normalizeCrawlPath(href, { origin, basePath }) {
  if (typeof href !== 'string' || href.trim().length === 0) return null;

  let url;
  try {
    url = new URL(href.trim(), new URL(basePath, origin));
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return null;
  if (SKIP_EXTENSIONS.has(extensionOf(url.pathname))) return null;

  return url.pathname;
}

/** 一頁裡所有可以爬的路徑，去重、保留出現順序 */
function collectCrawlTargets(html, { origin, basePath }) {
  const paths = extractAnchorHrefs(html)
    .map((href) => normalizeCrawlPath(href, { origin, basePath }))
    .filter((path) => path !== null);

  return [...new Set(paths)];
}

module.exports = { extractAnchorHrefs, normalizeCrawlPath, collectCrawlTargets, SKIP_EXTENSIONS };
