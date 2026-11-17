'use strict';

/**
 * `translations` 與 `translate_queue` 的 SQL。
 *
 * 快取是這個功能的**主幹**（靜態內容不常變 → 翻一次永久有效），所以讀取
 * 路徑是同步的 SQLite 查詢：代理在請求路徑上只做這件事，絕不等 ollama。
 *
 * `origin='manual'` 永遠優先（規格 §2）—— 這件事在兩個地方都要成立：
 *   1. 寫入：機器翻譯**不准覆蓋**人工覆寫（`DO UPDATE … WHERE origin <> 'manual'`）
 *   2. 讀取：同一段有 machine 也有 manual → 回 manual（跨模型也算）
 */

const crypto = require('node:crypto');

const { nowIso } = require('../lib/ids.js');

/**
 * 規格 §2 寫的是 `sha256(原文 + '\n' + target_lang + '\n' + model)`。
 *
 * ⛔ 刻意改成**長度前綴**而不是照抄：用 `\n` 當分隔時
 * `('a', 'b\nzh')` 與 `('a\nb', 'zh')` 會算出同一個 hash。
 * 實務上撞不到（`normalizeSpace` 已經把原文裡的換行壓成空格），但撞到的
 * 後果是「某一段拿到另一段的譯文」—— 跟規格 §1 最在意的錯位同一類的 bug，
 * 而且會被寫進永久快取。擋掉它的成本是三個數字，沒有理由不擋。
 *
 * 語意與規格一致：含 model，所以換模型會自動重翻。
 */
function translationHash(sourceText, targetLang, model) {
  const parts = [String(sourceText), String(targetLang), String(model)];
  const payload = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('\n');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * SQLite 的參數上限（預設 32766）。一頁的段數遠低於這個數字，
 * 但「預先翻譯整站」會一次查幾千段 —— 所以 lookup 自己分批。
 */
const LOOKUP_CHUNK = 400;

function chunk(items, size) {
  return items.reduce(
    (acc, item, index) =>
      index % size === 0 ? [...acc, [item]] : [...acc.slice(0, -1), [...acc[acc.length - 1], item]],
    [],
  );
}

/** LIKE 的萬用字元要跳脫，不然使用者搜 `%` 會撈出整張表 */
function likePattern(query) {
  return `%${String(query).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function mapRow(row) {
  return row
    ? {
        hash: row.hash,
        source_text: row.source_text,
        target_lang: row.target_lang,
        model: row.model,
        translated: row.translated,
        origin: row.origin,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    : null;
}

function getTranslation(db, hash) {
  return mapRow(db.prepare('SELECT * FROM translations WHERE hash = ?').get(hash));
}

/**
 * 寫入一筆機器翻譯。
 *
 * ⛔ `WHERE origin <> 'manual'` 是「人工改過的不准被背景翻譯蓋掉」的實作點。
 * 少了它，使用者辛苦改的譯文會在下一次重翻時無聲消失。
 */
function putTranslation(db, input) {
  const hash =
    input.hash ?? translationHash(input.source_text, input.target_lang, input.model);
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO translations
       (hash, source_text, target_lang, model, translated, origin, created_at, updated_at)
     VALUES
       (@hash, @source_text, @target_lang, @model, @translated, @origin, @created_at, @updated_at)
     ON CONFLICT(hash) DO UPDATE SET
       translated = excluded.translated,
       origin     = excluded.origin,
       updated_at = excluded.updated_at
     WHERE translations.origin <> 'manual'`,
  ).run({
    hash,
    source_text: input.source_text,
    target_lang: input.target_lang,
    model: input.model,
    translated: input.translated,
    origin: input.origin ?? 'machine',
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getTranslation(db, hash);
}

/** 人工覆寫：永遠蓋得過去，而且把 origin 標成 manual */
function setManualTranslation(db, hash, input) {
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO translations
       (hash, source_text, target_lang, model, translated, origin, created_at, updated_at)
     VALUES
       (@hash, @source_text, @target_lang, @model, @translated, 'manual', @created_at, @updated_at)
     ON CONFLICT(hash) DO UPDATE SET
       translated = excluded.translated,
       origin     = 'manual',
       updated_at = excluded.updated_at`,
  ).run({
    hash,
    source_text: input.source_text,
    target_lang: input.target_lang,
    model: input.model,
    translated: input.translated,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getTranslation(db, hash);
}

function removeTranslation(db, hash) {
  return db.prepare('DELETE FROM translations WHERE hash = ?').run(hash).changes > 0;
}

/**
 * 批次查快取。代理的請求路徑只做這一件事。
 *
 * 條件是 `model = ? OR origin = 'manual'`：人工覆寫**跨模型有效** ——
 * 換模型時使用者改過的譯文不該被丟掉（規格 §2 的「manual 永遠優先」）。
 *
 * @returns {Map<string, {translated: string, origin: string, model: string, hash: string}>}
 */
function lookupTranslations(db, { texts, targetLang, model }) {
  const unique = [...new Set(texts)];
  if (unique.length === 0) return new Map();

  const found = new Map();

  for (const group of chunk(unique, LOOKUP_CHUNK)) {
    const placeholders = group.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT hash, source_text, translated, origin, model
           FROM translations
          WHERE target_lang = ?
            AND source_text IN (${placeholders})
            AND (model = ? OR origin = 'manual')`,
      )
      .all(targetLang, ...group, model);

    for (const row of rows) {
      const existing = found.get(row.source_text);

      // manual 壓過 machine；同 origin 時先到的留著
      if (existing && (existing.origin === 'manual' || row.origin !== 'manual')) continue;

      found.set(row.source_text, {
        hash: row.hash,
        translated: row.translated,
        origin: row.origin,
        model: row.model,
      });
    }
  }

  return found;
}

/**
 * 「翻譯」分頁的表格。搜尋同時打原文與譯文（規格 §7）。
 */
function listTranslations(db, { query, origin, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (typeof query === 'string' && query.trim().length > 0) {
    conditions.push("(source_text LIKE ? ESCAPE '\\' OR translated LIKE ? ESCAPE '\\')");
    params.push(likePattern(query.trim()), likePattern(query.trim()));
  }
  if (origin === 'machine' || origin === 'manual') {
    conditions.push('origin = ?');
    params.push(origin);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT * FROM translations
       ${where}
       ORDER BY updated_at DESC, hash
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((row) => mapRow(row));
}

function countTranslations(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN origin = 'manual' THEN 1 ELSE 0 END) AS manual
         FROM translations`,
    )
    .get();

  return { total: row.total, manual: row.manual ?? 0 };
}

/* --------------------------- translate_queue --------------------------- */

/**
 * 把沒命中的段排進佇列。
 *
 * 已經在 `translations` 裡的段**跳過**（規格 §6：所以重跑整站很便宜）。
 * `INSERT OR IGNORE` 在這張表是安全的 —— 它沒有外鍵，所以那個 IGNORE
 * 只可能是「PK 撞到」（地雷 15 講的是有外鍵時會連違規一起吞掉）。
 * 而「撞到」正是我們要的語意：同一段排第二次不准把 attempts 歸零。
 *
 * @returns {number} 真的排進去幾筆
 */
function enqueueSegments(db, { texts, targetLang, model, siteId = null }) {
  const unique = [...new Set(texts)];
  if (unique.length === 0) return 0;

  const cached = lookupTranslations(db, { texts: unique, targetLang, model });
  const pending = unique.filter((text) => !cached.has(text));
  if (pending.length === 0) return 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO translate_queue
       (hash, source_text, target_lang, model, site_id, attempts, created_at)
     VALUES (@hash, @source_text, @target_lang, @model, @site_id, 0, @created_at)`,
  );

  const timestamp = nowIso();
  const apply = db.transaction(() =>
    pending.reduce(
      (added, text) =>
        added +
        insert.run({
          hash: translationHash(text, targetLang, model),
          source_text: text,
          target_lang: targetLang,
          model,
          site_id: siteId,
          created_at: timestamp,
        }).changes,
      0,
    ),
  );

  return apply();
}

/**
 * 拿一批還有重試額度的段（最舊的先）。
 *
 * `exclude` 是「這一輪已經試過的」—— 佇列跑一輪時，失敗的那批必須被跳過，
 * 否則下一次 claim 又拿到同一批（排序一樣），於是原地打轉。
 * 沒有它的話一次逾時就會把整條佇列卡死（實測：85 段全部停在那裡不動）。
 */
function claimQueue(db, { limit = 20, maxAttempts = 3, exclude = [] } = {}) {
  const placeholders = exclude.map(() => '?').join(', ');
  const notIn = exclude.length > 0 ? `AND hash NOT IN (${placeholders})` : '';

  return db
    .prepare(
      `SELECT * FROM translate_queue
        WHERE attempts < ?
        ${notIn}
        ORDER BY created_at, hash
        LIMIT ?`,
    )
    .all(maxAttempts, ...exclude, limit);
}

function clearQueue(db, hashes) {
  if (hashes.length === 0) return 0;

  const remove = db.prepare('DELETE FROM translate_queue WHERE hash = ?');
  const apply = db.transaction(() =>
    hashes.reduce((count, hash) => count + remove.run(hash).changes, 0),
  );

  return apply();
}

/**
 * 失敗：留在佇列、記下原因（規格 §4）。
 *
 * ⛔ `countAttempt: false` 是給「跟段落內容無關」的失敗用的（連不到 ollama、
 * HTTP 錯）。那種情況下燒掉 attempts，等於 ollama 關一小時就把整站的段落
 * 標成「翻不動」—— 而那些段落可能一個問題都沒有。
 * 原因還是要寫進 `last_error`，UI 才看得到發生什麼事。
 */
function recordQueueFailure(db, rows, error, { countAttempt = true } = {}) {
  if (rows.length === 0) return 0;

  const message = String(error ?? '未知錯誤').slice(0, 500);
  const update = db.prepare(
    countAttempt
      ? 'UPDATE translate_queue SET attempts = attempts + 1, last_error = ? WHERE hash = ?'
      : 'UPDATE translate_queue SET last_error = ? WHERE hash = ?',
  );

  const apply = db.transaction(() =>
    rows.reduce((count, row) => count + update.run(message, row.hash).changes, 0),
  );

  return apply();
}

function queueStats(db, { maxAttempts = 3 } = {}) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN attempts <  ? THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS failed
         FROM translate_queue`,
    )
    .get(maxAttempts, maxAttempts);

  return { pending: row.pending ?? 0, failed: row.failed ?? 0, total: row.total };
}

/** 翻不動的那些（規格 §7：UI 要能篩出來讓人工處理） */
function listFailedQueue(db, { maxAttempts = 3, limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT * FROM translate_queue
        WHERE attempts >= ?
        ORDER BY created_at, hash
        LIMIT ?`,
    )
    .all(maxAttempts, limit);
}

function removeQueueEntry(db, hash) {
  return db.prepare('DELETE FROM translate_queue WHERE hash = ?').run(hash).changes > 0;
}

module.exports = {
  translationHash,
  getTranslation,
  putTranslation,
  setManualTranslation,
  removeTranslation,
  lookupTranslations,
  listTranslations,
  countTranslations,
  enqueueSegments,
  claimQueue,
  clearQueue,
  recordQueueFailure,
  queueStats,
  listFailedQueue,
  removeQueueEntry,
  LOOKUP_CHUNK,
};
