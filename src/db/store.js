'use strict';

const sites = require('./sites.js');
const scripts = require('./scripts.js');

/**
 * 把 repository 函式綁上同一個 db handle，路由層就不用到處傳 db。
 * @param {import('better-sqlite3').Database} db
 */
function createStore(db) {
  return {
    db,
    sites: {
      create: (input) => sites.createSite(db, input),
      get: (id) => sites.getSite(db, id),
      list: () => sites.listSites(db),
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
  };
}

module.exports = { createStore };
