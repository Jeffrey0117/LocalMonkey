'use strict';

/**
 * `@require` / `@resource` 的伺服器端快取，內容定址（sha256 當 PK）。
 *
 * 為什麼存在伺服器端：離線可用、不會把使用者的瀏覽行為洩漏給 CDN、
 * 內容定址天然有完整性保證（網址改不了內容，內容變了就是另一個 sha）。
 */

const crypto = require('node:crypto');

const { nowIso } = require('../lib/ids.js');

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(String(content ?? ''), 'utf8');
}

/**
 * 存一份資產。同樣的內容再存一次只會更新 url / fetched_at，不會長出第二列。
 * @returns {{ sha256: string, url: string, content_type: string|null, bytes: number, fetched_at: string }}
 */
function putAsset(db, { url, content, content_type = null }) {
  const buffer = toBuffer(content);
  const row = {
    sha256: sha256Of(buffer),
    url,
    content: buffer,
    content_type,
    bytes: buffer.length,
    fetched_at: nowIso(),
  };

  db.prepare(
    `INSERT INTO assets (sha256, url, content, content_type, bytes, fetched_at)
     VALUES (@sha256, @url, @content, @content_type, @bytes, @fetched_at)
     ON CONFLICT(sha256) DO UPDATE SET
       url = excluded.url,
       content_type = excluded.content_type,
       fetched_at = excluded.fetched_at`,
  ).run(row);

  return {
    sha256: row.sha256,
    url: row.url,
    content_type: row.content_type,
    bytes: row.bytes,
    fetched_at: row.fetched_at,
  };
}

/** 含 content（投遞資產時要用） */
function getAsset(db, sha256) {
  return db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha256) ?? null;
}

/** 不含 content：只是用來判斷「這個網址抓過了沒」 */
function findAssetByUrl(db, url) {
  return (
    db
      .prepare(
        `SELECT sha256, url, content_type, bytes, fetched_at
           FROM assets WHERE url = ? ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(url) ?? null
  );
}

module.exports = { putAsset, getAsset, findAssetByUrl, sha256Of };
