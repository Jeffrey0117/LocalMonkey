'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { wrapUserCode } = require('../../src/lib/user-script.js');

/**
 * `@noframes`：這支腳本只在最上層頁面跑，不要在 iframe 裡跑。
 *
 * 判斷一定要在**瀏覽器端**做 —— 伺服器不知道這份 HTML 會不會被塞進 frame。
 * （真實樣本：ig-helper 宣告了 @noframes，IG 頁面裡有一堆 iframe。）
 */

function sandboxFor({ inFrame = false, topThrows = false } = {}) {
  const marker = [];
  const errors = [];

  const window = {
    requestIdleCallback: (handler) => handler(),
  };
  window.self = window;

  if (topThrows) {
    Object.defineProperty(window, 'top', {
      get() {
        throw new Error('跨來源：不給看 top');
      },
    });
  } else {
    window.top = inFrame ? { different: true } : window;
  }

  const sandbox = {
    window,
    marker,
    document: { readyState: 'complete', addEventListener: (type, handler) => handler() },
    setTimeout: (handler) => handler(),
    console: { error: (...args) => errors.push(args), warn: () => {} },
  };

  vm.createContext(sandbox);
  return { sandbox, marker, errors, run: (source) => new vm.Script(source).runInContext(sandbox) };
}

test('沒宣告 @noframes：在 iframe 裡也照跑', () => {
  const env = sandboxFor({ inFrame: true });
  env.run(wrapUserCode('a', 'marker.push("ran");'));

  assert.deepEqual(env.marker, ['ran']);
});

test('@noframes + 最上層頁面 → 照跑', () => {
  const env = sandboxFor({ inFrame: false });
  env.run(wrapUserCode('a', 'marker.push("ran");', { noframes: true }));

  assert.deepEqual(env.marker, ['ran']);
});

test('⭐ @noframes + 在 iframe 裡 → 不跑', () => {
  const env = sandboxFor({ inFrame: true });
  env.run(wrapUserCode('a', 'marker.push("ran");', { noframes: true }));

  assert.deepEqual(env.marker, [], 'iframe 裡不該執行');
  assert.deepEqual(env.errors, [], '不執行是正常行為，不要報錯');
});

test('@noframes + 讀 window.top 會丟錯（跨來源 frame）→ 當成在 iframe 裡，不跑', () => {
  const env = sandboxFor({ topThrows: true });

  assert.doesNotThrow(() => env.run(wrapUserCode('a', 'marker.push("ran");', { noframes: true })));
  assert.deepEqual(env.marker, []);
});

test('@noframes + document-idle：在 iframe 裡等到 idle 也還是不跑', () => {
  const env = sandboxFor({ inFrame: true });
  env.run(wrapUserCode('a', 'marker.push("ran");', { noframes: true, runAt: 'document-idle' }));

  assert.deepEqual(env.marker, []);
});

test('@noframes + document-idle + 最上層 → 跑得到', () => {
  const env = sandboxFor({ inFrame: false });
  env.run(wrapUserCode('a', 'marker.push("ran");', { noframes: true, runAt: 'document-idle' }));

  assert.deepEqual(env.marker, ['ran']);
});

test('@noframes + @grant：區域變數照樣宣告得出來', () => {
  const source = wrapUserCode('a', 'marker.push(typeof GM_setValue);', {
    noframes: true,
    scriptId: 'scr_x',
    grants: ['GM_setValue'],
  });

  assert.ok(source.includes('var GM_setValue = __lmApi["GM_setValue"];'));

  const env = sandboxFor({ inFrame: false });
  env.run(source);
  assert.deepEqual(env.marker, ['undefined'], 'shim 沒載入時是 undefined，但不該炸');
});

test('@noframes 的輸出是合法 JS', () => {
  for (const runAt of ['document-start', 'document-end', 'document-idle']) {
    const source = wrapUserCode('x', 'throw new Error("boom");', { noframes: true, runAt });
    assert.doesNotThrow(() => new vm.Script(source), runAt);
  }
});

test('window.top 不存在的環境（非瀏覽器）→ 當成最上層，照跑', () => {
  const marker = [];
  const sandbox = {
    window: {},
    marker,
    document: { readyState: 'complete', addEventListener: () => {} },
    console: { error: () => {}, warn: () => {} },
  };
  sandbox.window.self = sandbox.window;
  vm.createContext(sandbox);

  new vm.Script(wrapUserCode('a', 'marker.push("ran");', { noframes: true })).runInContext(sandbox);

  assert.deepEqual(marker, ['ran'], '判斷不出來的時候要讓腳本跑（fail open）');
});
