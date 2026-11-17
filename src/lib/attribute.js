'use strict';

/**
 * 從一個 tag 裡挑出「被引號包起來的」屬性值。
 *
 * ⛔ 為什麼不用帶 back-reference 的 `(["'])([^"']*)\1`：負向字元類裡不能放
 * back-reference，所以只能同時排除兩種引號 —— 於是
 * `content="0; url='https://x/'"`（外層雙引號、內層單引號）會整個比對失敗。
 * `"[^"]*"|'[^']*'` 的交替寫法才對。
 */

function attributePattern(name) {
  return new RegExp(`(\\b${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'i');
}

/**
 * @param {string} tag
 * @param {RegExp} pattern 由 `attributePattern()` 產生
 * @returns {{ matched: string, lead: string, quote: string, value: string }|null}
 */
function findQuotedAttribute(tag, pattern) {
  const found = pattern.exec(tag);
  if (!found) return null;

  const [matched, lead, quoted] = found;
  return { matched, lead, quote: quoted[0], value: quoted.slice(1, -1) };
}

/** 把屬性換成新值，其餘原樣。用函式當 replacement，網址裡的 `$&` 才不會被當 pattern。 */
function replaceAttribute(tag, attribute, value) {
  return tag.replace(
    attribute.matched,
    () => `${attribute.lead}${attribute.quote}${value}${attribute.quote}`,
  );
}

module.exports = { attributePattern, findQuotedAttribute, replaceAttribute };
