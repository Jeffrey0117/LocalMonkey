'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { wrapUserCode } = require('../../src/lib/user-script.js');

/**
 * 假的瀏覽器環境。`readyState` 可以切換，`requestIdleCallback` 可以拔掉，
 * 用來驗 document-idle 的兩條路徑（DOMContentLoaded → idle、以及 setTimeout fallback）。
 */
function browserSandbox({ readyState = 'loading', withIdleCallback = true } = {}) {
  const listeners = [];
  const timeouts = [];
  const errors = [];

  const sandbox = {
    marker: [],
    console: { error: (...args) => errors.push(args), warn: () => {}, info: () => {} },
    document: {
      readyState,
      addEventListener: (type, handler) => listeners.push({ type, handler }),
    },
    window: {},
    setTimeout: (handler) => {
      timeouts.push(handler);
      return timeouts.length;
    },
  };

  if (withIdleCallback) sandbox.window.requestIdleCallback = (handler) => timeouts.push(handler);

  vm.createContext(sandbox);

  return {
    sandbox,
    errors,
    run: (source) => new vm.Script(source).runInContext(sandbox),
    fireDomContentLoaded: () => {
      for (const entry of listeners.filter((item) => item.type === 'DOMContentLoaded')) {
        entry.handler();
      }
    },
    drainTimeouts: () => {
      while (timeouts.length > 0) timeouts.shift()();
    },
    listeners,
  };
}

test('沒指定 run_at 時行為跟 v1 完全一樣（立刻執行）', () => {
  const env = browserSandbox();
  env.run(wrapUserCode('a', 'marker.push("ran");'));

  assert.deepEqual(env.sandbox.marker, ['ran']);
});

test('document-start / document-end 也是立刻執行（位置由注入點決定，不是包裝）', () => {
  for (const runAt of ['document-start', 'document-end', 'head-end', 'body-end']) {
    const env = browserSandbox();
    env.run(wrapUserCode('a', 'marker.push("ran");', { runAt }));
    assert.deepEqual(env.sandbox.marker, ['ran'], runAt);
  }
});

test('document-idle：載入中時不立刻跑，等 DOMContentLoaded 之後的 idle', () => {
  const env = browserSandbox({ readyState: 'loading' });
  env.run(wrapUserCode('慢一點', 'marker.push("ran");', { runAt: 'document-idle' }));

  assert.deepEqual(env.sandbox.marker, [], '還在 loading 就不該跑');

  env.fireDomContentLoaded();
  assert.deepEqual(env.sandbox.marker, [], 'DOMContentLoaded 只是排進 idle 佇列');

  env.drainTimeouts();
  assert.deepEqual(env.sandbox.marker, ['ran']);
});

test('document-idle：DOM 已經好了就直接排 idle，不等 DOMContentLoaded', () => {
  const env = browserSandbox({ readyState: 'complete' });
  env.run(wrapUserCode('a', 'marker.push("ran");', { runAt: 'document-idle' }));

  assert.deepEqual(
    env.listeners.filter((entry) => entry.type === 'DOMContentLoaded'),
    [],
    'readyState 不是 loading 就不該掛 DOMContentLoaded（會永遠等不到）',
  );

  env.drainTimeouts();
  assert.deepEqual(env.sandbox.marker, ['ran']);
});

test('document-idle：沒有 requestIdleCallback 的瀏覽器退回 setTimeout', () => {
  const env = browserSandbox({ readyState: 'complete', withIdleCallback: false });
  env.run(wrapUserCode('a', 'marker.push("ran");', { runAt: 'document-idle' }));

  env.drainTimeouts();
  assert.deepEqual(env.sandbox.marker, ['ran']);
});

test('document-idle：腳本丟錯只會進 console.error，不會往外炸', () => {
  const env = browserSandbox({ readyState: 'complete' });
  env.run(wrapUserCode('壞腳本', 'throw new Error("boom");', { runAt: 'document-idle' }));

  assert.doesNotThrow(() => env.drainTimeouts());
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0][0], /\[LocalMonkey\] 壞腳本 執行失敗/);
});

test('⛔ 同一頁兩支 document-idle 腳本不會互相覆蓋（不准用全域函式名）', () => {
  const env = browserSandbox({ readyState: 'loading' });

  env.run(wrapUserCode('第一支', 'marker.push("first");', { runAt: 'document-idle' }));
  env.run(wrapUserCode('第二支', 'marker.push("second");', { runAt: 'document-idle' }));

  env.fireDomContentLoaded();
  env.drainTimeouts();

  assert.deepEqual(env.sandbox.marker, ['first', 'second'], '兩支都要跑到');
});

test('document-idle 的輸出是合法 JS（壞腳本不會讓整個檔案語法錯誤）', () => {
  const source = wrapUserCode('x', 'throw new Error("x"); // 結尾註解', { runAt: 'document-idle' });
  assert.doesNotThrow(() => new vm.Script(source));
});

test('document-idle 也是自己的 scope，const 不會互相撞名', () => {
  const env = browserSandbox({ readyState: 'complete' });

  env.run(wrapUserCode('a', 'const x = 1; marker.push(x);', { runAt: 'document-idle' }));
  env.run(wrapUserCode('b', 'const x = 2; marker.push(x);', { runAt: 'document-idle' }));

  env.drainTimeouts();
  assert.deepEqual(env.sandbox.marker, [1, 2]);
});
