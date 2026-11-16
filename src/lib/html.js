'use strict';

/**
 * HTML 改寫與腳本注入。
 *
 * 刻意用保守的正則而不是 HTML parser：零依賴、壞掉的頁面也不會被「修正」成
 * 另一種東西。代價是只認得被引號包起來的屬性值，這點寫在 README 的已知限制。
 */

const ROOT_PATH_ATTRIBUTES = ['src', 'href', 'action', 'poster', 'formaction'];

function escapeForRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function proxyPrefix(siteId) {
  return `/p/${siteId}`;
}

function needsRewrite(value, siteId) {
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false; // protocol-relative：視為跨網域
  const prefix = proxyPrefix(siteId);
  if (value === prefix || value.startsWith(`${prefix}/`)) return false; // 已經改寫過
  return true;
}

function rewriteValue(value, siteId) {
  return needsRewrite(value, siteId) ? `${proxyPrefix(siteId)}${value}` : value;
}

function rewriteSrcset(value, siteId) {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) return trimmed;

      const separator = trimmed.search(/\s/);
      if (separator === -1) return rewriteValue(trimmed, siteId);

      const url = trimmed.slice(0, separator);
      const descriptor = trimmed.slice(separator).trim();
      return `${rewriteValue(url, siteId)} ${descriptor}`;
    })
    .filter((candidate) => candidate.length > 0)
    .join(', ');
}

/**
 * 把「根絕對路徑」改寫成代理路徑：`src="/a.js"` → `src="/p/<siteId>/a.js"`。
 * `//cdn/x`、`https://x/y`、相對路徑、`#`、`?`、`data:` 等一律不動。
 */
function rewriteRootPaths(html, siteId) {
  if (typeof html !== 'string' || typeof siteId !== 'string') return html;

  const attributeNames = ROOT_PATH_ATTRIBUTES.map(escapeForRegExp).join('|');
  const attributeRe = new RegExp(`(\\s(?:${attributeNames})\\s*=\\s*)(["'])(/[^"']*)\\2`, 'gi');
  const srcsetRe = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;

  return html
    .replace(attributeRe, (match, lead, quote, value) => {
      const rewritten = rewriteValue(value, siteId);
      return rewritten === value ? match : `${lead}${quote}${rewritten}${quote}`;
    })
    .replace(srcsetRe, (match, lead, quote, value) => {
      const rewritten = rewriteSrcset(value, siteId);
      return rewritten === value ? match : `${lead}${quote}${rewritten}${quote}`;
    });
}

function scriptTag(scriptId) {
  return `<script src="/__lm/script/${encodeURIComponent(scriptId)}.js"></script>`;
}

function renderTags(scripts) {
  return scripts.map((script) => scriptTag(script.id)).join('\n');
}

function insertBefore(html, closingTag, payload, { fromEnd }) {
  const haystack = html.toLowerCase();
  const index = fromEnd ? haystack.lastIndexOf(closingTag) : haystack.indexOf(closingTag);
  if (index === -1) return `${html}\n${payload}`;
  return `${html.slice(0, index)}${payload}\n${html.slice(index)}`;
}

/**
 * @param {string} html
 * @param {{ head: Array<{id: string}>, body: Array<{id: string}> }} scripts 已依 order_index 排好
 */
function injectScripts(html, { head = [], body = [] } = {}) {
  if (typeof html !== 'string') return html;

  const withHead =
    head.length === 0 ? html : insertBefore(html, '</head>', renderTags(head), { fromEnd: false });

  return body.length === 0
    ? withHead
    : insertBefore(withHead, '</body>', renderTags(body), { fromEnd: true });
}

module.exports = { rewriteRootPaths, injectScripts, scriptTag, ROOT_PATH_ATTRIBUTES };
