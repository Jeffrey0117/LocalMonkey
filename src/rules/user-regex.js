'use strict';

/**
 * 使用者自己寫的正則 → `RegExp`，外加兩道保護。
 *
 * 規格 §2：「編譯失敗 → 規則停用並在 UI 標紅；加上執行時間上限防
 * catastrophic backtracking」。
 *
 * ⛔ JS 的正則比對是**同步而且不可中斷**的，所以「執行時間上限」沒辦法真的
 * 打斷一次比對。能做的是三層，缺一不可：
 *
 *   1. 編譯時擋掉已知會指數級回溯的形狀（這個檔案的 `hasNestedQuantifier`）
 *   2. 不把太長的字串餵進去（回溯成本跟長度成正比，見 rules/text.js）
 *   3. 累計時間預算：某條規則在這一份文件上花太久，就從下一段起停用它
 *      （也在 rules/text.js —— 它需要跨段的狀態）
 */

const MAX_PATTERN_LENGTH = 500;

/** `/foo/gi` 這種寫法（規格 §2：pattern 是「字串或 /正則/」） */
const SLASH_FORM = /^\/(.+)\/([gimsuy]*)$/s;

/**
 * 把「不影響結構」的東西拿掉，再看裡面有沒有量詞：
 * 跳脫序列（`\+` 是字面的加號）與字元類（`[+*]` 裡的也是字面的）。
 */
function structuralOnly(source) {
  return source.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
}

/** `*`、`+`、`{n,}` —— 上界無限的量詞才會爆 */
function hasUnboundedQuantifier(source) {
  return /[*+]/.test(source) || /\{\d*,\s*\}/.test(source);
}

/**
 * ⛔ 「量詞套在一個本身就有量詞或選擇分支的群組上」＝ `(a+)+`、`(a|aa)+`。
 * 這種形狀在不命中的輸入上會指數級回溯（`(a+)+$` 配 30 個 a 就要跑好幾秒）。
 *
 * 這是**保守的啟發式**：`(\d{2,4}\s+)+` 這種其實還好的寫法也會被擋下來。
 * 寧可擋掉一個能用的寫法（使用者看得到紅字、可以改），也不要讓代理整個卡住
 * —— 卡住的症狀是「頁面永遠轉圈圈」，而且完全沒有錯誤訊息。
 */
function hasNestedQuantifier(source) {
  const stack = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') {
      const close = source.indexOf(']', index + 1);
      index = close === -1 ? source.length : close;
      continue;
    }
    if (character === '(') {
      stack.push(index);
      continue;
    }
    if (character !== ')') continue;

    const start = stack.pop();
    if (start === undefined) continue;

    const after = source.slice(index + 1);
    const quantified = /^[*+]/.test(after) || /^\{\d*,\s*\}/.test(after);
    if (!quantified) continue;

    const body = structuralOnly(source.slice(start + 1, index));
    if (hasUnboundedQuantifier(body) || body.includes('|')) return true;
  }

  return false;
}

/**
 * @param {unknown} pattern
 * @param {{ defaultFlags?: string }} [options]
 * @returns {{ ok: true, value: RegExp } | { ok: false, error: string }}
 */
function compileUserRegex(pattern, { defaultFlags = 'g' } = {}) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, error: 'pattern 不能是空的' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `pattern 最長 ${MAX_PATTERN_LENGTH} 個字` };
  }

  const slashed = SLASH_FORM.exec(pattern);
  const source = slashed ? slashed[1] : pattern;
  const flags = slashed ? slashed[2] : defaultFlags;

  if (hasNestedQuantifier(source)) {
    return {
      ok: false,
      error: '這個正則有嵌套量詞（像 (a+)+ 或 (a|aa)+），會指數級回溯 —— 請改寫',
    };
  }

  try {
    return { ok: true, value: new RegExp(source, flags.includes('g') ? flags : `${flags}g`) };
  } catch (cause) {
    return { ok: false, error: `正則編譯失敗：${cause.message}` };
  }
}

module.exports = { compileUserRegex, hasNestedQuantifier, MAX_PATTERN_LENGTH };
