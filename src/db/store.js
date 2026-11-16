'use strict';

const sites = require('./sites.js');
const scripts = require('./scripts.js');
const userscripts = require('./userscripts.js');
const assets = require('./assets.js');

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
      listBindings: (id) => userscripts.listBindings(db, id),
    },
    assets: {
      put: (input) => assets.putAsset(db, input),
      get: (sha256) => assets.getAsset(db, sha256),
      findByUrl: (url) => assets.findAssetByUrl(db, url),
    },
  };
}

module.exports = { createStore };
