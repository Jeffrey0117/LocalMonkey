'use strict';

/**
 * 零依賴輸入驗證。每個 validator 回 `{ ok, value, errors }`，
 * errors 是 `[{ field, message }]`，直接可以吐給後台顯示。
 */

const { MAX_PATTERN_LENGTH } = require('./glob.js');

const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const RESERVED_SLUGS = new Set(['admin', 'p', '__lm']);
const RUN_AT_VALUES = new Set(['head-end', 'body-end']);
const MAX_CODE_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_ORDER_INDEX = 1_000_000;

function isPlainObject(input) {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function result(errors, value) {
  return errors.length > 0 ? { ok: false, errors, value: null } : { ok: true, errors: [], value };
}

function checkSlug(id, errors) {
  if (typeof id !== 'string' || !SLUG_PATTERN.test(id)) {
    errors.push({ field: 'id', message: 'id 只能是小寫英數與連字號，長度 1-40' });
    return null;
  }
  if (RESERVED_SLUGS.has(id)) {
    errors.push({ field: 'id', message: `id 不能用保留字：${[...RESERVED_SLUGS].join('、')}` });
    return null;
  }
  return id;
}

function checkName(name, errors, field = 'name') {
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push({ field, message: `${field} 不能是空的` });
    return null;
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    errors.push({ field, message: `${field} 最長 ${MAX_NAME_LENGTH} 個字` });
    return null;
  }
  return trimmed;
}

function checkTargetOrigin(input, errors) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    errors.push({ field: 'target_origin', message: 'target_origin 不能是空的' });
    return null;
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    errors.push({ field: 'target_origin', message: 'target_origin 不是合法網址（要帶 http:// 或 https://）' });
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push({ field: 'target_origin', message: 'target_origin 只接受 http 或 https' });
    return null;
  }
  if (url.username || url.password) {
    errors.push({ field: 'target_origin', message: 'target_origin 不要帶帳號密碼' });
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    errors.push({
      field: 'target_origin',
      message: `target_origin 只能是 origin（不含路徑），例如 ${url.origin}`,
    });
    return null;
  }
  if (!url.hostname) {
    errors.push({ field: 'target_origin', message: 'target_origin 缺少主機名' });
    return null;
  }

  return url.origin;
}

function checkEnabled(input, errors, field = 'enabled') {
  if (input === true || input === 1) return 1;
  if (input === false || input === 0) return 0;
  errors.push({ field, message: `${field} 只接受 true/false` });
  return null;
}

function checkCode(input, errors) {
  if (typeof input !== 'string' || input.length === 0) {
    errors.push({ field: 'code', message: 'code 不能是空的' });
    return null;
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_CODE_BYTES) {
    errors.push({ field: 'code', message: `code 最大 ${MAX_CODE_BYTES} bytes` });
    return null;
  }
  return input;
}

function checkMatchGlob(input, errors) {
  if (typeof input !== 'string' || input.length === 0) {
    errors.push({ field: 'match_glob', message: 'match_glob 不能是空的（全部頁面請用 *）' });
    return null;
  }
  if (input.length > MAX_PATTERN_LENGTH) {
    errors.push({ field: 'match_glob', message: `match_glob 最長 ${MAX_PATTERN_LENGTH} 個字` });
    return null;
  }
  if (/[\r\n\t]/.test(input)) {
    errors.push({ field: 'match_glob', message: 'match_glob 不能含換行或 tab' });
    return null;
  }
  return input;
}

function checkRunAt(input, errors) {
  if (typeof input !== 'string' || !RUN_AT_VALUES.has(input)) {
    errors.push({ field: 'run_at', message: "run_at 只能是 'head-end' 或 'body-end'" });
    return null;
  }
  return input;
}

function checkOrderIndex(input, errors) {
  if (typeof input !== 'number' || !Number.isInteger(input) || Math.abs(input) > MAX_ORDER_INDEX) {
    errors.push({ field: 'order_index', message: 'order_index 必須是整數' });
    return null;
  }
  return input;
}

function rejectImmutableField(input, field, errors) {
  if (field in input) {
    errors.push({ field, message: `${field} 不能用更新改掉` });
  }
}

function validateSiteCreate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const id = checkSlug(input.id, errors);
  const name = checkName(input.name, errors);
  const targetOrigin = checkTargetOrigin(input.target_origin, errors);
  const enabled = 'enabled' in input ? checkEnabled(input.enabled, errors) : 1;

  return result(errors, { id, name, target_origin: targetOrigin, enabled });
}

function validateSiteUpdate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  rejectImmutableField(input, 'id', errors);

  const patch = {};
  if ('name' in input) patch.name = checkName(input.name, errors);
  if ('target_origin' in input) patch.target_origin = checkTargetOrigin(input.target_origin, errors);
  if ('enabled' in input) patch.enabled = checkEnabled(input.enabled, errors);

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push({ field: 'body', message: '沒有任何要更新的欄位' });
  }

  return result(errors, patch);
}

function validateScriptCreate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const value = {
    name: checkName(input.name, errors),
    code: checkCode(input.code, errors),
    enabled: 'enabled' in input ? checkEnabled(input.enabled, errors) : 1,
    match_glob: 'match_glob' in input ? checkMatchGlob(input.match_glob, errors) : '*',
    run_at: 'run_at' in input ? checkRunAt(input.run_at, errors) : 'body-end',
    order_index: 'order_index' in input ? checkOrderIndex(input.order_index, errors) : 0,
  };

  return result(errors, value);
}

function validateScriptUpdate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  rejectImmutableField(input, 'site_id', errors);
  rejectImmutableField(input, 'id', errors);

  const patch = {};
  if ('name' in input) patch.name = checkName(input.name, errors);
  if ('code' in input) patch.code = checkCode(input.code, errors);
  if ('enabled' in input) patch.enabled = checkEnabled(input.enabled, errors);
  if ('match_glob' in input) patch.match_glob = checkMatchGlob(input.match_glob, errors);
  if ('run_at' in input) patch.run_at = checkRunAt(input.run_at, errors);
  if ('order_index' in input) patch.order_index = checkOrderIndex(input.order_index, errors);

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push({ field: 'body', message: '沒有任何要更新的欄位' });
  }

  return result(errors, patch);
}

/* --------------------------------------------------------------------- *
 * v2：使用者只給一份 userscript 原文，其他欄位全部從 header 解析出來。
 * 所以這裡**刻意沒有** name / match / run_at 的驗證 —— 那些不是輸入。
 * --------------------------------------------------------------------- */

function checkSource(input, errors) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    errors.push({ field: 'source', message: 'source 不能是空的' });
    return null;
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_CODE_BYTES) {
    errors.push({ field: 'source', message: `source 最大 ${MAX_CODE_BYTES} bytes` });
    return null;
  }
  return input;
}

function checkFallbackName(input, errors) {
  if (typeof input !== 'string') {
    errors.push({ field: 'fallbackName', message: 'fallbackName 必須是字串' });
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > MAX_NAME_LENGTH ? trimmed.slice(0, MAX_NAME_LENGTH) : trimmed;
}

function validateUserscriptCreate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const value = {
    source: checkSource(input.source, errors),
    ...('enabled' in input ? { enabled: checkEnabled(input.enabled, errors) } : {}),
    ...('order_index' in input ? { order_index: checkOrderIndex(input.order_index, errors) } : {}),
    ...('fallbackName' in input ? { fallbackName: checkFallbackName(input.fallbackName, errors) } : {}),
  };

  return result(errors, value);
}

function validateUserscriptUpdate(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  rejectImmutableField(input, 'id', errors);
  rejectImmutableField(input, 'site_id', errors);
  rejectImmutableField(input, 'metadata', errors);

  const patch = {};
  if ('source' in input) patch.source = checkSource(input.source, errors);
  if ('enabled' in input) patch.enabled = checkEnabled(input.enabled, errors);
  if ('order_index' in input) patch.order_index = checkOrderIndex(input.order_index, errors);

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push({ field: 'body', message: '沒有任何要更新的欄位' });
  }

  return result(errors, patch);
}

function validateParseRequest(input) {
  if (!isPlainObject(input)) {
    return result([{ field: 'body', message: '請求內容必須是 JSON 物件' }]);
  }

  const errors = [];
  const value = {
    source: checkSource(input.source, errors),
    ...('fallbackName' in input ? { fallbackName: checkFallbackName(input.fallbackName, errors) } : {}),
  };

  return result(errors, value);
}

module.exports = {
  validateSiteCreate,
  validateSiteUpdate,
  validateScriptCreate,
  validateScriptUpdate,
  validateUserscriptCreate,
  validateUserscriptUpdate,
  validateParseRequest,
  MAX_CODE_BYTES,
  MAX_NAME_LENGTH,
  RESERVED_SLUGS,
  RUN_AT_VALUES,
  SLUG_PATTERN,
};
