'use strict';

/**
 * v5（SPEC-rules）的輸入驗證：改造規則與資源覆寫。
 *
 * 自己一個檔案而不是塞進 `lib/validate.js` —— 那支已經 430 行，而且這一組
 * 有自己的一套判準（CSS 選擇器、正則、上游路徑、上傳的檔案）。
 *
 * ⛔ 刻意**不**在這裡擋「編譯不過的規則」：規格 §4 要的是「正則編譯失敗 →
 * 該列標紅並說明原因」，那表示它得先存得起來。把它退回去的話使用者只會看到
 * 一個 400，沒有上下文、也沒有那條半成品可以繼續改。真正的編譯檢查在
 * `rules/compile.js`，API 回應會把 `error` 一起帶給 UI。
 */

const { RULE_KINDS, MAX_REPLACEMENT_LENGTH } = require('../rules/compile.js');

const MAX_PATTERN_LENGTH = 500;
const MAX_SCOPE_LENGTH = 200;
const MAX_NOTE_LENGTH = 200;
const MAX_PATH_LENGTH = 300;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_ORDER_INDEX = 1_000_000;

/** 點陣圖的 magic bytes。**聞出來的才算**，宣告的 content-type 是使用者可控的字串。 */
const IMAGE_SIGNATURES = Object.freeze([
  { type: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') },
  {
    type: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    type: 'image/avif',
    test: (b) =>
      b.length > 12 &&
      b.subarray(4, 8).toString('latin1') === 'ftyp' &&
      ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1')),
  },
  { type: 'image/bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  {
    type: 'image/vnd.microsoft.icon',
    test: (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00,
  },
]);

function isPlainObject(input) {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function result(errors, value) {
  return errors.length > 0 ? { ok: false, errors, value: null } : { ok: true, errors: [], value };
}

function checkPattern(input, errors) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    errors.push({ field: 'pattern', message: 'pattern 不能是空的' });
    return null;
  }
  if (input.length > MAX_PATTERN_LENGTH) {
    errors.push({ field: 'pattern', message: `pattern 最長 ${MAX_PATTERN_LENGTH} 個字` });
    return null;
  }
  if (/[\r\n\t\0]/.test(input)) {
    errors.push({ field: 'pattern', message: 'pattern 不能含換行、tab 或控制字元' });
    return null;
  }
  return input;
}

function checkReplacement(input, errors) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    errors.push({ field: 'replacement', message: 'replacement 必須是字串' });
    return null;
  }
  if (input.length > MAX_REPLACEMENT_LENGTH) {
    errors.push({ field: 'replacement', message: `replacement 最長 ${MAX_REPLACEMENT_LENGTH} 個字` });
    return null;
  }
  if (/[\r\n\0]/.test(input)) {
    errors.push({ field: 'replacement', message: 'replacement 不能含換行' });
    return null;
  }
  return input;
}

/** 留空 ＝ 全站（規格 §3.2），所以空字串與空白都折成 null */
function checkScope(input, errors) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    errors.push({ field: 'scope', message: 'scope 必須是字串' });
    return null;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SCOPE_LENGTH) {
    errors.push({ field: 'scope', message: `scope 最長 ${MAX_SCOPE_LENGTH} 個字` });
    return null;
  }
  return trimmed;
}

function checkNote(input, errors) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    errors.push({ field: 'note', message: 'note 必須是字串' });
    return null;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) {
    errors.push({ field: 'note', message: `note 最長 ${MAX_NOTE_LENGTH} 個字` });
    return null;
  }
  return trimmed;
}

function checkKind(input, errors) {
  if (typeof input !== 'string' || !RULE_KINDS.includes(input)) {
    errors.push({ field: 'kind', message: `kind 只能是 ${RULE_KINDS.join(' / ')}` });
    return null;
  }
  return input;
}

function checkEnabled(input, errors, field = 'enabled') {
  if (input === true || input === 1) return 1;
  if (input === false || input === 0) return 0;
  errors.push({ field, message: `${field} 只接受 true/false` });
  return null;
}

function checkOrderIndex(input, errors) {
  if (!Number.isInteger(input) || input < 0 || input > MAX_ORDER_INDEX) {
    errors.push({ field: 'order_index', message: 'order_index 必須是 0 以上的整數' });
    return null;
  }
  return input;
}

function validateRuleCreate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const value = {
    kind: checkKind(input.kind, errors),
    pattern: checkPattern(input.pattern, errors),
    replacement: checkReplacement(input.replacement, errors),
    scope: checkScope(input.scope, errors),
    note: checkNote(input.note, errors),
    enabled: 'enabled' in input ? checkEnabled(input.enabled, errors) : 1,
    ...('order_index' in input ? { order_index: checkOrderIndex(input.order_index, errors) } : {}),
  };

  return result(errors, value);
}

function validateRuleUpdate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  for (const field of ['id', 'site_id']) {
    if (field in input) errors.push({ field, message: `${field} 不能用更新改掉` });
  }

  const patch = {};
  if ('kind' in input) patch.kind = checkKind(input.kind, errors);
  if ('pattern' in input) patch.pattern = checkPattern(input.pattern, errors);
  if ('replacement' in input) patch.replacement = checkReplacement(input.replacement, errors);
  if ('scope' in input) patch.scope = checkScope(input.scope, errors);
  if ('note' in input) patch.note = checkNote(input.note, errors);
  if ('enabled' in input) patch.enabled = checkEnabled(input.enabled, errors);
  if ('order_index' in input) patch.order_index = checkOrderIndex(input.order_index, errors);

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push({ field: 'body', message: '沒有任何要更新的欄位' });
  }

  return result(errors, patch);
}

function validateRuleOrder(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const { ids } = input;

  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push({ field: 'ids', message: 'ids 必須是至少一個 id 的陣列' });
  } else if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    errors.push({ field: 'ids', message: 'ids 裡每一筆都要是字串' });
  } else if (new Set(ids).size !== ids.length) {
    errors.push({ field: 'ids', message: 'ids 不能有重複' });
  }

  return result(errors, { ids });
}

/**
 * 上游路徑（例 `/images/templatemo-logo-new.png`）。
 *
 * 這個字串會被拿去跟「代理轉給上游的 path」逐字比對，所以**不做任何正規化**，
 * 只收乾淨的形狀：以 `/` 開頭、沒有 query / hash、沒有 `..`、不是絕對網址。
 * 正規化等於在兩邊製造「看起來一樣但不相等」的機會。
 */
function validateResourcePath(input) {
  const errors = [];

  if (typeof input !== 'string' || input.length === 0) {
    errors.push({ field: 'path', message: 'path 不能是空的' });
    return result(errors, null);
  }
  if (input.length > MAX_PATH_LENGTH) {
    errors.push({ field: 'path', message: `path 最長 ${MAX_PATH_LENGTH} 個字` });
  }
  if (!input.startsWith('/') || input.startsWith('//')) {
    errors.push({ field: 'path', message: 'path 要以單一個 / 開頭（是上游路徑，不是網址）' });
  }
  if (input.includes('?') || input.includes('#')) {
    errors.push({ field: 'path', message: 'path 不能含 query 或 hash' });
  }
  if (input.split('/').includes('..')) {
    errors.push({ field: 'path', message: 'path 不能含 ..' });
  }
  if (/[\s\0]/.test(input)) {
    errors.push({ field: 'path', message: 'path 不能含空白或控制字元' });
  }

  return result(errors, input);
}

/** 聞一下這包 byte 是什麼圖 */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return IMAGE_SIGNATURES.find((signature) => signature.test(buffer))?.type ?? null;
}

/**
 * 上傳的檔案。
 *
 * ⛔ **只收點陣圖，SVG 一律拒絕**（規格 §3.6）：SVG 可以內嵌 `<script>`，
 * 而這張圖是從**我們自己的 origin** 送出去的 —— 等於給它一個同源頁面去打
 * `/admin/api/*`（後台 cookie 的 Path=/admin，瀏覽器會幫它帶上）。
 * 這跟 `/__lm/asset/*` 的 content-type 白名單、favicon 拒收 SVG 是同一個理由。
 *
 * content-type 以**聞出來的**為準，不是宣告的：宣告是使用者可控的字串。
 */
function validateResourceUpload(buffer, declaredType) {
  const errors = [];

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    errors.push({ field: 'content', message: '沒有收到檔案內容' });
    return result(errors, null);
  }
  if (buffer.length > MAX_RESOURCE_BYTES) {
    errors.push({ field: 'content', message: `檔案最大 ${MAX_RESOURCE_BYTES} bytes` });
    return result(errors, null);
  }

  const declared = String(declaredType ?? '').split(';')[0].trim().toLowerCase();
  if (declared === 'image/svg+xml') {
    errors.push({
      field: 'content_type',
      message: 'SVG 不收：它可以內嵌 script，而這張圖是從 LocalMonkey 自己的網域送出去的',
    });
    return result(errors, null);
  }

  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    errors.push({
      field: 'content',
      message: '這不是看得出來的點陣圖（PNG / JPEG / GIF / WebP / AVIF / BMP / ICO）',
    });
    return result(errors, null);
  }

  return result(errors, { content: buffer, content_type: sniffed, bytes: buffer.length });
}

module.exports = {
  validateRuleCreate,
  validateRuleUpdate,
  validateRuleOrder,
  validateResourcePath,
  validateResourceUpload,
  sniffImageType,
  MAX_RESOURCE_BYTES,
  MAX_PATH_LENGTH,
};
