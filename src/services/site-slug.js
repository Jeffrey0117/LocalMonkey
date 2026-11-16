'use strict';

/**
 * 主機名 → 代理網址用的 slug。純函式。
 *
 * 刻意保留完整主機（`shopee.tw` → `shopee-tw`，不是 `shopee`）：
 * 砍掉 TLD 會讓 shopee.tw 與 shopee.com 撞在一起，而代理網址是要給人看的。
 */

const { SLUG_PATTERN, RESERVED_SLUGS } = require('../lib/validate.js');

const MAX_SLUG_LENGTH = 40;
const FALLBACK_SLUG = 'site';
const MAX_SUFFIX = 99;

function trimDashes(value) {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * @param {string} host 例如 `www.example.com` 或 `localhost:3000`
 * @returns {string} 一定符合 SLUG_PATTERN，而且不是保留字
 */
function slugForHost(host) {
  const raw = typeof host === 'string' ? host : '';
  const withoutWww = raw.toLowerCase().replace(/^www\./, '');

  const slug = trimDashes(
    trimDashes(withoutWww.replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG_LENGTH),
  );

  if (slug.length === 0) return FALLBACK_SLUG;
  if (RESERVED_SLUGS.has(slug)) return trimDashes(`${slug}-site`.slice(0, MAX_SLUG_LENGTH));
  if (!SLUG_PATTERN.test(slug)) return FALLBACK_SLUG;

  return slug;
}

/**
 * 撞名就加數字後綴。`isTaken` 由呼叫端提供（通常是查 DB）。
 * @param {string} base
 * @param {(slug: string) => boolean} isTaken
 * @returns {string}
 */
function uniqueSlug(base, isTaken) {
  if (!isTaken(base)) return base;

  for (let suffix = 2; suffix <= MAX_SUFFIX; suffix += 1) {
    const tail = `-${suffix}`;
    const trimmed = trimDashes(base.slice(0, MAX_SLUG_LENGTH - tail.length));
    const candidate = `${trimmed}${tail}`;

    if (!isTaken(candidate)) return candidate;
  }

  throw new Error(`找不到可用的網站 slug（${base} 到 ${base}-${MAX_SUFFIX} 都被佔用了）`);
}

module.exports = { slugForHost, uniqueSlug, MAX_SLUG_LENGTH, FALLBACK_SLUG };
