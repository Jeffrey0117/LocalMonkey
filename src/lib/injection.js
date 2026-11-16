'use strict';

/**
 * 決定「這一頁要注入哪些 <script>，各自插在哪裡」。純函式。
 *
 * 一支腳本在一個站可能有多條 path_glob（多個 @match 指到同一個主機），
 * 所以 listForInjection 會回「一個綁定一列」；這裡負責比對路徑、套用排除、
 * 去重，再把投遞順序排好：
 *
 *     GM shim → @require 的資產 → 使用者腳本
 */

const { matchGlob } = require('./glob.js');

const BUCKET_BY_RUN_AT = Object.freeze({
  'document-start': 'headStart',
  'head-end': 'head', // v1 相容：位置與 v1 完全一樣（</head> 之前）
  'document-end': 'body',
  'document-idle': 'body', // 延後是在投遞的 JS 裡做（見 lib/user-script.js）
  'body-end': 'body', // v1 相容
});

function scriptUrl(scriptId) {
  return `/__lm/script/${encodeURIComponent(scriptId)}.js`;
}

function shimUrl(scriptId) {
  return `/__lm/shim/${encodeURIComponent(scriptId)}.js`;
}

function assetUrl(sha256) {
  return `/__lm/asset/${encodeURIComponent(sha256)}.js`;
}

function bucketFor(runAt) {
  return BUCKET_BY_RUN_AT[runAt] ?? 'body';
}

function isExcluded(row, pathname) {
  const globs = Array.isArray(row.exclude_globs) ? row.exclude_globs : [];
  return globs.some((glob) => matchGlob(glob, pathname));
}

function requireAssetsOf(metadata) {
  const assets = metadata?.requireAssets;
  return Array.isArray(assets) ? assets : [];
}

/** shim → requires → 腳本本身 */
function entriesFor(row) {
  const shim = row.metadata?.needsShim
    ? [{ src: shimUrl(row.id), kind: 'shim', scriptId: row.id }]
    : [];

  const requires = requireAssetsOf(row.metadata)
    .filter((asset) => typeof asset?.sha256 === 'string' && asset.sha256.length > 0)
    .map((asset) => ({ src: assetUrl(asset.sha256), kind: 'require', scriptId: row.id }));

  return [...shim, ...requires, { src: scriptUrl(row.id), kind: 'script', scriptId: row.id }];
}

/**
 * @param {Array<object>} rows db/userscripts.js 的 listForInjection 結果（已排序）
 * @param {{ pathname: string }} context
 * @returns {{ headStart: object[], head: object[], body: object[] }}
 */
function planInjection(rows, { pathname } = {}) {
  const plan = { headStart: [], head: [], body: [] };
  if (!Array.isArray(rows)) return plan;

  const decided = new Set();

  for (const row of rows) {
    if (decided.has(row.id)) continue;
    if (!matchGlob(row.path_glob, pathname)) continue;

    // 排除優先於配對（跟 Tampermonkey 一致）：命中就整支不跑
    decided.add(row.id);
    if (isExcluded(row, pathname)) continue;

    plan[bucketFor(row.run_at)].push(...entriesFor(row));
  }

  return plan;
}

module.exports = { planInjection, scriptUrl, shimUrl, assetUrl, bucketFor, BUCKET_BY_RUN_AT };
