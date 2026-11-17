'use strict';

/**
 * `crawl_jobs`：「預先翻譯整站」的工作與進度（規格 §2 / §6）。
 *
 * 進度寫進 DB 而不是放在記憶體，有兩個理由：
 *   1. UI 是輪詢的（沒有 WebSocket），要從某處讀
 *   2. **取消要能立刻生效** —— 爬蟲每一步都回頭讀 `status`，所以「取消」
 *      就只是一次 UPDATE，不需要跨模組的旗標或事件
 */

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'status',
  'pages_done',
  'pages_found',
  'segments_new',
  'last_error',
]);

function mapRow(row) {
  return row
    ? {
        id: row.id,
        site_id: row.site_id,
        status: row.status,
        start_path: row.start_path,
        max_pages: row.max_pages,
        max_depth: row.max_depth,
        pages_done: row.pages_done,
        pages_found: row.pages_found,
        segments_new: row.segments_new,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    : null;
}

function getCrawlJob(db, id) {
  return mapRow(db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(id));
}

function createCrawlJob(db, input) {
  const id = input.id ?? newId('crawl');
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO crawl_jobs
       (id, site_id, status, start_path, max_pages, max_depth,
        pages_done, pages_found, segments_new, created_at, updated_at)
     VALUES
       (@id, @site_id, 'running', @start_path, @max_pages, @max_depth,
        0, 0, 0, @created_at, @updated_at)`,
  ).run({
    id,
    site_id: input.site_id,
    start_path: input.start_path,
    max_pages: input.max_pages,
    max_depth: input.max_depth,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getCrawlJob(db, id);
}

function updateCrawlJob(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const params = columns.reduce((acc, column) => ({ ...acc, [column]: patch[column] }), {
    id,
    updated_at: nowIso(),
  });
  const assignments = [...columns, 'updated_at'].map((column) => `${column} = @${column}`);

  const result = db
    .prepare(`UPDATE crawl_jobs SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到爬取工作「${id}」`);

  return getCrawlJob(db, id);
}

/** 進度用相對加總，不用「讀出來 +1 再寫回去」（少一次來回，也不會互相覆蓋） */
function bumpCrawlJob(db, id, { pages_done = 0, pages_found = 0, segments_new = 0 } = {}) {
  db.prepare(
    `UPDATE crawl_jobs
        SET pages_done   = pages_done   + @pages_done,
            pages_found  = pages_found  + @pages_found,
            segments_new = segments_new + @segments_new,
            updated_at   = @updated_at
      WHERE id = @id`,
  ).run({ id, pages_done, pages_found, segments_new, updated_at: nowIso() });

  return getCrawlJob(db, id);
}

function listCrawlJobsBySite(db, siteId, { limit = 10 } = {}) {
  return db
    .prepare('SELECT * FROM crawl_jobs WHERE site_id = ? ORDER BY created_at DESC, id LIMIT ?')
    .all(siteId, limit)
    .map((row) => mapRow(row));
}

function latestCrawlJobForSite(db, siteId) {
  return listCrawlJobsBySite(db, siteId, { limit: 1 })[0] ?? null;
}

module.exports = {
  createCrawlJob,
  getCrawlJob,
  updateCrawlJob,
  bumpCrawlJob,
  listCrawlJobsBySite,
  latestCrawlJobForSite,
  UPDATABLE_COLUMNS,
};
