'use strict';

/**
 * 把使用者的腳本包一層 try/catch 再送出去。
 * 一支壞腳本不該讓同一頁的其他腳本跟著死，所以錯誤只進 console。
 */

/**
 * 產生 JS 字串字面值。除了 JSON.stringify 的轉義，額外把 `/` 轉義掉：
 * 這樣字面值裡就不會出現 `*\/` 或 `<\/script>` 這種能跳出上下文的序列。
 */
function jsStringLiteral(value) {
  return JSON.stringify(String(value)).replace(/\//g, '\\/');
}

function commentSafe(value) {
  return String(value)
    .replace(/\*\//g, '* /')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * @param {string} name 腳本名稱（只用來做錯誤訊息）
 * @param {string} code 使用者的原始程式碼
 * @returns {string} 可直接當 .js 回應的內容
 */
function wrapUserCode(name, code) {
  const label = `[LocalMonkey] ${name} 執行失敗`;

  return [
    `/* LocalMonkey script: ${commentSafe(name)} */`,
    'try {',
    String(code),
    '} catch (error) {',
    `  console.error(${jsStringLiteral(label)}, error);`,
    '}',
    '',
  ].join('\n');
}

module.exports = { wrapUserCode, jsStringLiteral };
