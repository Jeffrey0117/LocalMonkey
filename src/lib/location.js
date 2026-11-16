'use strict';

/**
 * 3xx 的 Location 改寫：指向上游自己的就折回代理路徑，指向別人的原樣放行
 * （代理不該把整個網際網路都吸進來）。
 */

function proxyPath(siteId, pathWithQuery) {
  return `/p/${siteId}${pathWithQuery}`;
}

function rewriteLocation(location, site) {
  if (typeof location !== 'string' || location.length === 0) return location;
  if (!site || typeof site.id !== 'string') return location;

  const prefix = `/p/${site.id}`;

  if (location.startsWith('//')) return location; // protocol-relative = 跨網域

  if (location.startsWith('/')) {
    if (location === prefix || location.startsWith(`${prefix}/`)) return location;
    return proxyPath(site.id, location);
  }

  let url;
  try {
    url = new URL(location);
  } catch {
    return location; // 相對路徑或壞網址：交給瀏覽器自己解析
  }

  if (url.origin !== site.target_origin) return location;

  return proxyPath(site.id, `${url.pathname}${url.search}${url.hash}`);
}

module.exports = { rewriteLocation };
