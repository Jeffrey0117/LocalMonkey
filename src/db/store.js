'use strict';

const sites = require('./sites.js');
const scripts = require('./scripts.js');
const userscripts = require('./userscripts.js');
const assets = require('./assets.js');
const translations = require('./translations.js');
const crawlJobs = require('./crawl-jobs.js');
const siteRules = require('./site-rules.js');
const resourceOverrides = require('./resource-overrides.js');
const reskin = require('./reskin.js');
const reskinOrders = require('./reskin-orders.js');

/**
 * 把 repository 函式綁上同一個 db handle，路由層就不用到處傳 db。
 *
 * `store.scripts` 是 v1 的相容投影（code / site_id / match_glob），
 * `store.userscripts` 才是 v2 的主要 API（source / metadata / 多站綁定）。
 * 兩者背後是同一組表。
 *
 * @param {import('better-sqlite3').Database} db
 */
function createStore(db) {
  return {
    db,
    sites: {
      create: (input) => sites.createSite(db, input),
      get: (id) => sites.getSite(db, id),
      list: () => sites.listSites(db),
      listWithScripts: () => sites.listSitesWithScripts(db),
      update: (id, patch) => sites.updateSite(db, id, patch),
      remove: (id) => sites.removeSite(db, id),
    },
    scripts: {
      create: (siteId, input) => scripts.createScript(db, siteId, input),
      get: (id) => scripts.getScript(db, id),
      listBySite: (siteId) => scripts.listScriptsBySite(db, siteId),
      listActiveForSite: (siteId) => scripts.listActiveForSite(db, siteId),
      update: (id, patch) => scripts.updateScript(db, id, patch),
      remove: (id) => scripts.removeScript(db, id),
    },
    userscripts: {
      create: (input) => userscripts.createUserscript(db, input),
      get: (id) => userscripts.getUserscript(db, id),
      list: () => userscripts.listUserscripts(db),
      listForInjection: (siteId) => userscripts.listForInjection(db, siteId),
      update: (id, patch) => userscripts.updateUserscript(db, id, patch),
      remove: (id) => userscripts.removeUserscript(db, id),
      setBindings: (id, bindings) => userscripts.setBindings(db, id, bindings),
      getByDeliveryToken: (token) => userscripts.getByDeliveryToken(db, token),
      rotateDeliveryToken: (id) => userscripts.rotateDeliveryToken(db, id),
      listBindings: (id) => userscripts.listBindings(db, id),
    },
    assets: {
      put: (input) => assets.putAsset(db, input),
      get: (sha256) => assets.getAsset(db, sha256),
      findByUrl: (url) => assets.findAssetByUrl(db, url),
    },

    /* v4：翻譯快取（主幹）與待翻佇列 */
    translations: {
      get: (hash) => translations.getTranslation(db, hash),
      put: (input) => translations.putTranslation(db, input),
      setManual: (hash, input) => translations.setManualTranslation(db, hash, input),
      remove: (hash) => translations.removeTranslation(db, hash),
      lookup: (input) => translations.lookupTranslations(db, input),
      list: (options) => translations.listTranslations(db, options),
      iterate: () => translations.iterateTranslations(db),
      count: () => translations.countTranslations(db),
    },
    translateQueue: {
      enqueue: (input) => translations.enqueueSegments(db, input),
      claim: (options) => translations.claimQueue(db, options),
      clear: (hashes) => translations.clearQueue(db, hashes),
      recordFailure: (rows, error, options) =>
        translations.recordQueueFailure(db, rows, error, options),
      stats: (options) => translations.queueStats(db, options),
      listFailed: (options) => translations.listFailedQueue(db, options),
      remove: (hash) => translations.removeQueueEntry(db, hash),
    },
    /* v5：使用者自訂的站台改造規則與資源覆寫（SPEC-rules） */
    siteRules: {
      create: (siteId, input) => siteRules.createSiteRule(db, siteId, input),
      get: (id) => siteRules.getSiteRule(db, id),
      listBySite: (siteId) => siteRules.listSiteRules(db, siteId),
      update: (id, patch) => siteRules.updateSiteRule(db, id, patch),
      remove: (id) => siteRules.removeSiteRule(db, id),
      reorder: (siteId, ids) => siteRules.reorderSiteRules(db, siteId, ids),
      counts: () => siteRules.countSiteRules(db),
    },
    resourceOverrides: {
      put: (siteId, input) => resourceOverrides.putResourceOverride(db, siteId, input),
      get: (id) => resourceOverrides.getResourceOverride(db, id),
      listBySite: (siteId) => resourceOverrides.listResourceOverrides(db, siteId),
      find: (siteId, path) => resourceOverrides.findResourceOverride(db, siteId, path),
      versions: (siteId) => resourceOverrides.resourceVersions(db, siteId),
      update: (id, patch) => resourceOverrides.updateResourceOverride(db, id, patch),
      remove: (id) => resourceOverrides.removeResourceOverride(db, id),
    },

    /**
     * v8：重繪模式抽出來的資料（SPEC-reskin §3.3）。
     * 純衍生快取 —— 清掉只是下一次重算，不會掉任何使用者的設定。
     */
    reskinCache: {
      key: (input) => reskin.cacheKey(input),
      get: (key) => reskin.getReskinCache(db, key),
      put: (input) => reskin.putReskinCache(db, input),
      trim: (siteId, limit) => reskin.trimReskinCache(db, siteId, limit),
      clear: (siteId) => reskin.clearReskinCache(db, siteId),
      count: (siteId) => reskin.countReskinCache(db, siteId),
    },

    /**
     * v9：單筆買斷的訂單（SPEC-checkout §3）。
     *
     * ⛔ 跟上面的 `reskinCache` 是**相反**的東西：那個清掉只是重算一次，
     * 這個清掉就沒了。所以沒有 `clear`，`site_id` 也沒有外鍵
     * （刪站不連帶刪訂單，理由在 `db/reskin-orders.js`）。
     */
    reskinOrders: {
      create: (input) => reskinOrders.createReskinOrder(db, input),
      get: (id) => reskinOrders.getReskinOrder(db, id),
      markPaid: (input) => reskinOrders.markReskinOrderPaid(db, input),
      markFailed: (input) => reskinOrders.markReskinOrderFailed(db, input),
      list: (options) => reskinOrders.listReskinOrders(db, options),
      count: (siteId) => reskinOrders.countReskinOrders(db, siteId),
    },

    crawlJobs: {
      create: (input) => crawlJobs.createCrawlJob(db, input),
      get: (id) => crawlJobs.getCrawlJob(db, id),
      update: (id, patch) => crawlJobs.updateCrawlJob(db, id, patch),
      listBySite: (siteId, options) => crawlJobs.listCrawlJobsBySite(db, siteId, options),
      latestForSite: (siteId) => crawlJobs.latestCrawlJobForSite(db, siteId),
      bump: (id, counters) => crawlJobs.bumpCrawlJob(db, id, counters),
    },
  };
}

module.exports = { createStore };
