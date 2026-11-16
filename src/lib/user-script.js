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
 * `@run-at document-idle`：等 DOM 好了再趁空閒跑。
 *
 * ⛔ 整段包在 IIFE 裡，而且不用任何全域名字 —— 同一頁可能有兩支 idle 腳本，
 * 用 `function run()` 這種全域宣告的話，後載入的那支會把前一支的 run 覆蓋掉，
 * 結果只有一支真的執行（而且完全不報錯）。
 */
function idleWrapper(label, code) {
  return [
    '(function () {',
    '  var run = function () {',
    '    try {',
    String(code),
    '    } catch (error) {',
    `      console.error(${jsStringLiteral(label)}, error);`,
    '    }',
    '  };',
    '  var idle = function () {',
    '    var schedule = (typeof window !== "undefined" && window.requestIdleCallback)',
    '      ? window.requestIdleCallback',
    '      : function (fn) { return setTimeout(fn, 1); };',
    '    schedule(run);',
    '  };',
    "  if (document.readyState === 'loading') {",
    "    document.addEventListener('DOMContentLoaded', idle, { once: true });",
    '  } else {',
    '    idle();',
    '  }',
    '})();',
  ].join('\n');
}

/**
 * @param {string} name 腳本名稱（只用來做錯誤訊息）
 * @param {string} code 使用者的原始程式碼
 * @param {{ runAt?: string }} [options]
 * @returns {string} 可直接當 .js 回應的內容
 */
function wrapUserCode(name, code, options = {}) {
  const label = `[LocalMonkey] ${name} 執行失敗`;

  if (options.runAt === 'document-idle') {
    return [
      `/* LocalMonkey script (document-idle): ${commentSafe(name)} */`,
      idleWrapper(label, code),
      '',
    ].join('\n');
  }

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
