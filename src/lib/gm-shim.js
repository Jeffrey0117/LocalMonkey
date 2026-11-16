'use strict';

/**
 * GM shim 的伺服器端：組 config + 把 shim 原始碼與 config 接起來。
 *
 * shim 本體在 `src/public/gm-shim.js`（瀏覽器端），這裡只在啟動時讀一次檔。
 * 沒有 build step —— 要改 shim 就直接改那個檔，重啟即生效。
 */

const fs = require('node:fs');
const path = require('node:path');

const { isValidGrantName } = require('../userscript/grants.js');

const SHIM_PATH = path.join(__dirname, '..', 'public', 'gm-shim.js');
const XHR_ENDPOINT = '/__lm/gm/xhr';

/** GM_getResourceText 是同步 API，所以文字內容只能在這裡預先嵌進去 */
const INLINE_TEXT_LIMIT = 256 * 1024;
const TEXT_CONTENT_TYPES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/xml',
  'image/svg+xml',
];

let cachedSource = null;

function shimSource() {
  if (cachedSource === null) cachedSource = fs.readFileSync(SHIM_PATH, 'utf8');
  return cachedSource;
}

function isTextual(contentType) {
  const declared = String(contentType ?? '').toLowerCase();
  return TEXT_CONTENT_TYPES.some((prefix) => declared.startsWith(prefix));
}

/**
 * JSON 直接當 JS 字面值送出去時要補的轉義：
 * `<` 擋掉 `</script>`（萬一哪天被內嵌進 HTML），U+2028/2029 在 JS 字串字面值裡是換行。
 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildResources(resourceAssets, loadAsset) {
  const entries = Array.isArray(resourceAssets) ? resourceAssets : [];

  return entries.reduce((acc, entry) => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') return acc;

    const asset = typeof loadAsset === 'function' ? loadAsset(entry.sha256) : null;
    const inlineable =
      asset &&
      Buffer.isBuffer(asset.content) &&
      asset.bytes <= INLINE_TEXT_LIMIT &&
      isTextual(asset.content_type);

    return {
      ...acc,
      [entry.name]: {
        url: entry.url ?? null,
        sha256: entry.sha256,
        assetUrl: `/__lm/asset/${encodeURIComponent(entry.sha256)}`,
        ...(inlineable ? { text: asset.content.toString('utf8') } : {}),
      },
    };
  }, {});
}

/**
 * @param {object} script db/userscripts.js 的 get() 結果
 * @param {{ loadAsset?: (sha256: string) => object|null }} [options]
 */
function buildShimConfig(script, options = {}) {
  const metadata = script.metadata ?? {};
  const targets = Array.isArray(metadata.targets) ? metadata.targets : [];
  const excludes = Array.isArray(metadata.excludes) ? metadata.excludes : [];

  return {
    scriptId: script.id,
    name: script.name,
    version: script.version ?? null,
    namespace: metadata.namespace ?? null,
    description: script.description ?? null,
    runAt: script.run_at,
    grants: (Array.isArray(metadata.grants) ? metadata.grants : []).filter((grant) =>
      isValidGrantName(grant),
    ),
    unsupported: Array.isArray(metadata.unsupportedGrants) ? metadata.unsupportedGrants : [],
    connect: Array.isArray(metadata.connect) ? metadata.connect : [],
    matches: targets.filter((target) => target.kind === 'match').map((target) => target.pattern),
    includes: targets.filter((target) => target.kind === 'include').map((target) => target.pattern),
    excludes: excludes.map((exclude) => exclude.pattern),
    resources: buildResources(metadata.resourceAssets, options.loadAsset),
    xhrEndpoint: XHR_ENDPOINT,
  };
}

/**
 * @param {object} config buildShimConfig 的結果
 * @returns {string} 可直接當 .js 回應的內容
 */
function renderShim(config) {
  return `${shimSource()}\n;window.__localMonkey.install(${safeJson(config)});\n`;
}

module.exports = {
  buildShimConfig,
  renderShim,
  safeJson,
  isTextual,
  INLINE_TEXT_LIMIT,
  XHR_ENDPOINT,
  SHIM_PATH,
};
