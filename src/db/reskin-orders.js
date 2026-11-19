'use strict';

/**
 * `reskin_orders`：單筆買斷的訂單（SPEC-checkout §3）。
 *
 * ⛔ **這是這個專案裡唯一「掉了就回不來」的資料。** 其他東西都能重算：
 * `reskin_cache` 是純衍生資料、`translations` 重翻一次就有、腳本在使用者手上
 * 也有一份。訂單不是 —— 它記的是「誰付了多少錢」，而且是我們這邊唯一能跟
 * 金流對帳的憑據。整個檔案的設計都往這個方向偏。
 *
 * ## ⛔ `site_id` 刻意**不是**外鍵
 *
 * `reskin_cache` 是 `ON DELETE CASCADE`（純衍生資料，CASCADE 沒有損失）。
 * 訂單**相反**：刪一個站不該把那個站收過的錢一起刪掉。這跟
 * `translate_queue.site_id` 不設外鍵是同一個判斷（CLAUDE.md 的資料模型段），
 * 只是這裡的代價更高 —— 所以寧可留下「孤兒訂單」也不要靜默刪除。
 *
 * ## ⛔ 狀態轉移靠 SQL 的 WHERE，不靠先讀再寫
 *
 * 同一筆訂單會被回呼打到兩次以上是**正常的**（ReturnURL 與 NotifyURL 都會送，
 * 使用者還可能重新整理那一頁）。`markPaid` 的條件寫在 UPDATE 裡
 * （`WHERE id = ? AND status <> 'paid'`），回傳 `changes` 讓呼叫端分得出
 * 「這次結算了」與「早就結算過」—— 先 SELECT 再 UPDATE 的話那個判斷會有一個
 * 空隙，而結果是同一筆訂單被處理兩次（規格 §2.2 第 4 條）。
 */

const { nowIso } = require('../lib/ids.js');

const STATUSES = Object.freeze(['pending', 'paid', 'failed', 'cancelled']);
const DEFAULT_CURRENCY = 'TWD';

/** 控制台的訂單清單一次拿幾筆 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function createReskinOrder(db, input) {
  const row = {
    id: input.id,
    site_id: input.siteId,
    product_id: input.productId,
    product_name: input.productName,
    amount: input.amount,
    currency: input.currency ?? DEFAULT_CURRENCY,
    status: 'pending',
    env: input.env,
    created_at: nowIso(),
  };

  db.prepare(
    `INSERT INTO reskin_orders
       (id, site_id, product_id, product_name, amount, currency, status, env, created_at)
     VALUES
       (@id, @site_id, @product_id, @product_name, @amount, @currency, @status, @env, @created_at)`,
  ).run(row);

  return getReskinOrder(db, row.id);
}

function getReskinOrder(db, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return db.prepare('SELECT * FROM reskin_orders WHERE id = ?').get(id) ?? null;
}

/**
 * 結算成功。
 *
 * @returns {number} `1` ＝ 這次真的改了；`0` ＝ 已經是 paid（重複回呼，不要
 *   再做第二次「付款成功」該做的事）
 */
function markReskinOrderPaid(db, { id, tradeNo = null, rawResult = null }) {
  return db
    .prepare(
      `UPDATE reskin_orders
          SET status = 'paid', trade_no = @trade_no, paid_at = @paid_at, raw_result = @raw_result
        WHERE id = @id AND status <> 'paid'`,
    )
    .run({ id, trade_no: tradeNo, paid_at: nowIso(), raw_result: rawResult }).changes;
}

/**
 * 結算失敗／取消。
 *
 * ⛔ **已經 paid 的訂單不准被改掉。** 回呼的順序不保證（notify 與 return 誰先
 * 到都有可能），而「付款成功之後又收到一筆失敗的回應」不該讓使用者的訂單
 * 退回失敗。
 */
function markReskinOrderFailed(db, { id, status = 'failed', rawResult = null }) {
  if (!STATUSES.includes(status) || status === 'paid') {
    throw new Error(`markReskinOrderFailed 只收 failed / cancelled / pending，收到「${status}」`);
  }

  return db
    .prepare(
      `UPDATE reskin_orders
          SET status = @status, raw_result = @raw_result
        WHERE id = @id AND status <> 'paid'`,
    )
    .run({ id, status, raw_result: rawResult }).changes;
}

/** 控制台的訂單清單（唯讀，規格 §3）。最新的在最前面。 */
function listReskinOrders(db, { siteId, limit = DEFAULT_LIMIT } = {}) {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

  return siteId === undefined || siteId === null
    ? db
        .prepare('SELECT * FROM reskin_orders ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(capped)
    : db
        .prepare(
          `SELECT * FROM reskin_orders WHERE site_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(siteId, capped);
}

function countReskinOrders(db, siteId) {
  return siteId === undefined || siteId === null
    ? db.prepare('SELECT COUNT(*) AS total FROM reskin_orders').get().total
    : db.prepare('SELECT COUNT(*) AS total FROM reskin_orders WHERE site_id = ?').get(siteId).total;
}

module.exports = {
  createReskinOrder,
  getReskinOrder,
  markReskinOrderPaid,
  markReskinOrderFailed,
  listReskinOrders,
  countReskinOrders,
  STATUSES,
  DEFAULT_CURRENCY,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
