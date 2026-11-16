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

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scriptTag(scriptId) {
  return `<script src="/__lm/script/${encodeURIComponent(scriptId)}.js"></script>`;
}

/**
 * entry 可以是 `{ id }`（v1：腳本投遞路徑）或 `{ src }`（任意路徑：GM shim、@require 資產）。
 */
function tagFor(entry) {
  return typeof entry.src === 'string'
    ? `<script src="${escapeAttribute(entry.src)}"></script>`
    : scriptTag(entry.id);
}

function renderTags(entries) {
  return entries.map((entry) => tagFor(entry)).join('\n');
}

function insertBefore(html, closingTag, payload, { fromEnd }) {
  const haystack = html.toLowerCase();
  const index = fromEnd ? haystack.lastIndexOf(closingTag) : haystack.indexOf(closingTag);
  if (index === -1) return `${html}\n${payload}`;
  return `${html.slice(0, index)}${payload}\n${html.slice(index)}`;
}

const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const HTML_OPEN_PATTERN = /<html\b[^>]*>/i;
const DOCTYPE_PATTERN = /<!doctype[^>]*>/i;

/**
 * 插在 `<head>` 的**第一個子元素**。
 *
 * ⛔ 這跟 v1 的 head-end（`</head>` 之前）不一樣，而且差別很要緊：
 * `</head>` 之前已經晚於頁面自己的 `<script>`，想 hook `fetch` / `XMLHttpRequest`
 * 的 document-start 腳本在那個位置會完全失效。
 *
 * 退路依序是 `<html>` 之後 → doctype 之後 → 整份文件最前面。
 * doctype 一定要留在最前面，不然瀏覽器會掉進 quirks mode。
 */
function insertAtHeadStart(html, payload) {
  if (typeof html !== 'string' || typeof payload !== 'string' || payload.length === 0) {
    return html;
  }

  for (const pattern of [HEAD_OPEN_PATTERN, HTML_OPEN_PATTERN, DOCTYPE_PATTERN]) {
    const matched = pattern.exec(html);
    if (!matched) continue;

    const at = matched.index + matched[0].length;
    return `${html.slice(0, at)}${payload}${html.slice(at)}`;
  }

  return `${payload}\n${html}`;
}

/**
 * @param {string} html
 * @param {{
 *   headStart?: Array<{id?: string, src?: string}>,
 *   head?: Array<{id?: string, src?: string}>,
 *   body?: Array<{id?: string, src?: string}>,
 * }} scripts 已依 order_index 排好
 */
function injectScripts(html, { headStart = [], head = [], body = [] } = {}) {
  if (typeof html !== 'string') return html;

  const withHeadStart =
    headStart.length === 0 ? html : insertAtHeadStart(html, renderTags(headStart));

  const withHead =
    head.length === 0
      ? withHeadStart
      : insertBefore(withHeadStart, '</head>', renderTags(head), { fromEnd: false });

  return body.length === 0
    ? withHead
    : insertBefore(withHead, '</body>', renderTags(body), { fromEnd: true });
}

module.exports = {
  rewriteRootPaths,
  injectScripts,
  insertAtHeadStart,
  scriptTag,
  ROOT_PATH_ATTRIBUTES,
};
