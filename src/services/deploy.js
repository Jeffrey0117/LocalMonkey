'use strict';

/**
 * 「部署一支腳本」：解析 → 自動建站 → 重算綁定 → 抓 @require / @resource。
 *
 * 這是 v2 的核心流程，也是後台唯一的寫入路徑。使用者只給一份 source，
 * 其他（名稱、網域、時機、權限）全部從 header 推出來 —— **單一真相來源**。
 */

const { parseUserscript } = require('../userscript/parse.js');
const { excludeAppliesToHost } = require('../userscript/match.js');
const { blockedConnectHosts } = require('../lib/gm-allow-hosts.js');
const { slugForHost, uniqueSlug } = require('./site-slug.js');
const { fetchAsset } = require('./fetch-asset.js');

const MAX_SOURCE_BYTES = 1024 * 1024;

class DeployError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeployError';
  }
}

function assertSource(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new DeployError('腳本內容不能是空的');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new DeployError(`腳本內容最大 ${MAX_SOURCE_BYTES} bytes`);
  }
}

/**
 * 找到（或建立）這個 target 對應的站。
 * 已經有同一個 target_origin 的站就重複用 —— 包括使用者自己手動建的，
 * 那種站不要去改它的名字或 auto_created 旗標。
 */
function ensureSite(store, target) {
  const existing = store.sites
    .list()
    .find((site) => site.target_origin === target.targetOrigin);

  if (existing) return existing;

  const slug = uniqueSlug(slugForHost(target.host), (candidate) => store.sites.get(candidate) !== null);

  return store.sites.create({
    id: slug,
    name: target.host,
    target_origin: target.targetOrigin,
    auto_created: 1,
    from_pattern: target.pattern,
  });
}

/** 這個站要套用哪些排除規則（萬用主機的排除規則對每個站都生效） */
function excludesForHost(excludes, host) {
  return excludes
    .filter((exclude) => excludeAppliesToHost(exclude.hostScope, host))
    .map((exclude) => exclude.pathGlob);
}

function resolveTargets(store, parsed) {
  return parsed.targets.map((target) => {
    if (target.proxyable === 'rejected') return { ...target, siteId: null };

    const site = ensureSite(store, target);
    return { ...target, siteId: site.id };
  });
}

function bindingsFor(resolved, parsed) {
  return resolved
    .filter((target) => target.siteId !== null)
    .map((target) => ({
      site_id: target.siteId,
      path_glob: target.pathGlob,
      exclude_globs: excludesForHost(parsed.excludes, target.host),
    }));
}

/** 把 @require / @resource 抓回來。每個 URL 只抓一次，失敗不擋存檔。 */
async function collectAssets(context, parsed) {
  const { store, config } = context;
  const options = {
    allowPrivate: config.allowPrivate,
    timeoutMs: config.assetTimeoutMs,
    maxBytes: config.assetMaxBytes,
    fetchImpl: context.fetchImpl,
    lookup: context.lookup,
  };

  const urls = [...new Set([...parsed.requires, ...parsed.resources.map((entry) => entry.url)])];
  const results = new Map();

  for (const url of urls) {
    // 刻意循序：一支腳本的 @require 通常只有幾個，而循序比較不會打爆對方
    results.set(url, await fetchAsset(store, url, options));
  }

  const warnings = [...results.values()]
    .filter((result) => result.sha256 === null)
    .map((result) => `@require / @resource「${result.url}」失效：${result.error}`);

  return {
    requireAssets: parsed.requires.map((url) => {
      const result = results.get(url);
      return { url, sha256: result.sha256, ...(result.error ? { error: result.error } : {}) };
    }),
    resourceAssets: parsed.resources.map((entry) => {
      const result = results.get(entry.url);
      return {
        name: entry.name,
        url: entry.url,
        sha256: result.sha256,
        ...(result.error ? { error: result.error } : {}),
      };
    }),
    warnings,
  };
}

/**
 * 腳本宣告了本機位址的 `@connect`，但那個主機沒進 GM 白名單 → 會靜默失敗。
 * 靜默失敗是最糟的結果，所以存檔時就大聲講出來，並附上要設的 env。
 */
function allowlistWarnings(parsed, config) {
  const blocked = blockedConnectHosts(parsed.connect, config?.gmXhr?.allowHosts);
  if (blocked.length === 0) return [];

  return [
    `這支腳本要用 GM_xmlhttpRequest 連 ${blocked.join('、')}（本機位址）。` +
      'SSRF 防護會擋下來，除非把確切的 host:port 加進 LOCALMONKEY_GM_ALLOW_HOSTS' +
      '（例如 LOCALMONKEY_GM_ALLOW_HOSTS=localhost:8001），然後重啟 LocalMonkey。',
  ];
}

function writeScript(store, { scriptId, source, parsed, metadata, enabled, orderIndex }) {
  const fields = {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    source,
    metadata,
    run_at: parsed.runAt,
    ...(enabled === undefined ? {} : { enabled }),
    ...(orderIndex === undefined ? {} : { order_index: orderIndex }),
  };

  if (scriptId) {
    if (!store.userscripts.get(scriptId)) throw new DeployError(`找不到腳本「${scriptId}」`);
    return store.userscripts.update(scriptId, fields);
  }

  return store.userscripts.create(fields);
}

/**
 * @param {{ store: object, config: object, fetchImpl?: typeof fetch, logger?: object, lookup?: Function }} context
 * @param {{ source: string, scriptId?: string, enabled?: number|boolean, order_index?: number, fallbackName?: string }} input
 * @returns {Promise<{ script: object, targets: object[], warnings: string[] }>}
 */
async function deployUserscript(context, input) {
  const { store } = context;
  const { source, scriptId, fallbackName } = input;

  assertSource(source);

  const parsed = parseUserscript(source, { fallbackName });
  const resolved = resolveTargets(store, parsed);
  const assets = await collectAssets(context, parsed);

  const metadata = {
    ...parsed,
    requireAssets: assets.requireAssets,
    resourceAssets: assets.resourceAssets,
  };

  const script = writeScript(store, {
    scriptId,
    source,
    parsed,
    metadata,
    enabled: input.enabled,
    orderIndex: input.order_index,
  });

  store.userscripts.setBindings(script.id, bindingsFor(resolved, parsed));

  const warnings = [
    ...parsed.notices.map((notice) => notice.message),
    ...assets.warnings,
    ...allowlistWarnings(parsed, context.config),
  ];

  return {
    script: store.userscripts.get(script.id),
    targets: resolved,
    warnings,
  };
}

module.exports = { deployUserscript, DeployError, ensureSite, MAX_SOURCE_BYTES };
