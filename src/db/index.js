'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { migrate, SCHEMA_VERSION } = require('./migrations.js');

/**
 * 開 DB 並跑 migration。`:memory:` 給測試用。
 * @param {string} file
 */
function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
