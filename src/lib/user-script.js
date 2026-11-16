'use strict';

/**
 * 把使用者的腳本包一層再送出去。
 *
 * 三件事：
 *   1. try/catch —— 一支壞腳本不該讓同一頁的其他腳本跟著死。
 *   2. 有 @grant 的話，在這支腳本自己的 scope 裡宣告 GM_* 區域變數。
 *      ⛔ 刻意**不**把 GM_* 掛到 window：同一頁多支腳本會互相蓋掉，
 *         而 document-idle 的腳本執行時所有 shim 都裝完了，百分之百拿到別人的。
 *   3. document-idle 的延後執行。
 */

const { aliasNamesFor } = require('../userscript/grants.js');

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

/** v1 的形狀：沒有 @grant 又不是 document-idle 的腳本維持原樣 */
function plainWrapper(name, code, label) {
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

function aliasLines(scriptId, aliases) {
  if (aliases.length === 0) return [];

  const lookup = `(window.__localMonkey && window.__localMonkey.apis && window.__localMonkey.apis[${jsStringLiteral(scriptId ?? '')}]) || {}`;

  return [
    `  var __lmApi = ${lookup};`,
    ...aliases.map((alias) => `  var ${alias} = __lmApi[${jsStringLiteral(alias)}];`),
  ];
}

/**
 * document-idle 的排程。整段在 IIFE 裡，沒有任何全域名字 ——
 * 用 `function run()` 的話，同一頁的第二支 idle 腳本會覆蓋第一支，
 * 結果只有一支真的執行，而且完全不報錯。
 */
const IDLE_LINES = [
  '  var __lmIdle = function () {',
  '    var schedule = (typeof window !== "undefined" && window.requestIdleCallback)',
  '      ? window.requestIdleCallback',
  '      : function (fn) { return setTimeout(fn, 1); };',
  '    schedule(__lmRun);',
  '  };',
  "  if (document.readyState === 'loading') {",
  "    document.addEventListener('DOMContentLoaded', __lmIdle, { once: true });",
  '  } else {',
  '    __lmIdle();',
  '  }',
];

/**
 * @param {string} name 腳本名稱（只用來做錯誤訊息）
 * @param {string} code 使用者的原始程式碼
 * @param {{ runAt?: string, scriptId?: string, grants?: readonly string[] }} [options]
 * @returns {string} 可直接當 .js 回應的內容
 */
function wrapUserCode(name, code, options = {}) {
  const label = `[LocalMonkey] ${name} 執行失敗`;
  const aliases = aliasNamesFor(options.grants);
  const idle = options.runAt === 'document-idle';

  if (!idle && aliases.length === 0) return plainWrapper(name, code, label);

  const suffix = idle ? ' (document-idle)' : '';

  return [
    `/* LocalMonkey script${suffix}: ${commentSafe(name)} */`,
    '(function () {',
    ...aliasLines(options.scriptId, aliases),
    '  var __lmRun = function () {',
    '    try {',
    String(code),
    '    } catch (error) {',
    `      console.error(${jsStringLiteral(label)}, error);`,
    '    }',
    '  };',
    ...(idle ? IDLE_LINES : ['  __lmRun();']),
    '})();',
    '',
  ].join('\n');
}

module.exports = { wrapUserCode, jsStringLiteral };
