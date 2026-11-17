'use strict';

/**
 * 這份文件宣告的是什麼編碼？
 *
 * ⛔ 為什麼翻譯層需要這個，而代理的其他改寫不需要：
 *
 * HTML 改寫全程走 latin1（byte-lossless），所以 v1~v3 從來不用管 charset ——
 * 插進去的東西全是 ASCII，不管頁面是 UTF-8 還是 Big5 都安全。
 * **翻譯會插入中文**，而中文的 byte 表示法跟頁面宣告的編碼綁在一起：
 * 把 UTF-8 的 byte 插進一份宣告 Big5 的頁面，使用者看到的是亂碼。
 *
 * 所以規則是：**只有明確宣告 UTF-8 的文件才翻**。沒宣告的也不翻 ——
 * 瀏覽器會自己猜（Chrome 在不少語系預設 windows-1252），猜錯就是整頁亂碼。
 *
 * 規格 §3 沒提這件事，這是實作時補上的安全邊界。代價是非 UTF-8 的站不會
 * 被翻譯（而 2026 年的站幾乎都是 UTF-8），換到的是「絕不把頁面弄成亂碼」。
 */

/** 瀏覽器只掃文件開頭找 meta charset（規範是 1024 byte），超過就不理 */
const META_SCAN_LENGTH = 4096;

const CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*"?([a-z0-9_:.+-]+)"?/i;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;

/** WHATWG 的 UTF-8 別名 */
const UTF8_LABELS = new Set([
  'utf-8',
  'utf8',
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'x-unicode20utf8',
  'csutf8',
]);

/**
 * @param {string} html latin1 管線字串也可以（charset 宣告一律是 ASCII）
 * @param {string|null|undefined} contentType 上游的 content-type header
 * @returns {string|null} 小寫的編碼名稱，沒宣告就是 null
 */
function documentCharset(html, contentType) {
  const fromHeader =
    typeof contentType === 'string' ? CHARSET_IN_CONTENT_TYPE.exec(contentType) : null;
  if (fromHeader) return fromHeader[1].toLowerCase();

  if (typeof html !== 'string') return null;

  // `<meta charset>` 與 `<meta http-equiv content="...; charset=...">` 同一條 regex 吃
  const fromMeta = META_CHARSET.exec(html.slice(0, META_SCAN_LENGTH));
  return fromMeta ? fromMeta[1].toLowerCase() : null;
}

function isUtf8Label(label) {
  return typeof label === 'string' && UTF8_LABELS.has(label.toLowerCase());
}

/** 翻譯層唯一在意的問題：這份文件能不能安全地插入 UTF-8 中文？ */
function isUtf8Document(html, contentType) {
  return isUtf8Label(documentCharset(html, contentType));
}

module.exports = { documentCharset, isUtf8Document, isUtf8Label, UTF8_LABELS, META_SCAN_LENGTH };
