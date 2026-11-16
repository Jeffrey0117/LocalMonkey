'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { wrapUserCode } = require('../../src/lib/user-script.js');

function runInSandbox(source) {
  const calls = [];
  const sandbox = {
    console: {
      error: (...args) => calls.push(args),
      info: () => {},
    },
    marker: null,
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  return { calls, sandbox };
}

test('原始碼原文被包進去', () => {
  const out = wrapUserCode('hide ads', 'marker = 42;');
  assert.ok(out.includes('marker = 42;'));
  assert.ok(out.includes('try'));
  assert.ok(out.includes('catch'));
});

test('腳本正常時照跑', () => {
  const { sandbox, calls } = runInSandbox(wrapUserCode('ok script', 'marker = 7;'));
  assert.equal(sandbox.marker, 7);
  assert.deepEqual(calls, []);
});

test('腳本丟錯時被 catch 住並 console.error，不會往外炸', () => {
  const { calls } = runInSandbox(wrapUserCode('壞腳本', 'throw new Error("boom");'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '[LocalMonkey] 壞腳本 執行失敗');
  assert.equal(calls[0][1].message, 'boom');
});

test('名字含引號 / 反斜線 / 註解結尾符號也不會產生壞語法', () => {
  const nasty = 'a"b\'c\\d */ </script> `e`';
  const source = wrapUserCode(nasty, 'marker = 1;');
  assert.doesNotThrow(() => new vm.Script(source), '產生的程式碼要能編譯');
  assert.equal(source.includes('*/ </script>'), false, '不准讓 */ 原樣留在註解裡');
  const { calls } = runInSandbox(wrapUserCode(nasty, 'throw new Error("x")'));
  assert.ok(calls[0][0].includes('a"b'));
});

test('程式碼最後一行是 // 註解時不會把收尾的大括號吃掉', () => {
  const source = wrapUserCode('trailing comment', 'marker = 3; // 結尾註解');
  assert.doesNotThrow(() => new vm.Script(source));
  const { sandbox } = runInSandbox(source);
  assert.equal(sandbox.marker, 3);
});

test('每支腳本是自己的 scope，const 不會互相撞名', () => {
  const combined = `${wrapUserCode('a', 'const x = 1; marker = x;')}\n${wrapUserCode('b', 'const x = 2; marker = marker + x;')}`;
  assert.doesNotThrow(() => new vm.Script(combined));
  const { sandbox, calls } = runInSandbox(combined);
  assert.equal(sandbox.marker, 3);
  assert.deepEqual(calls, []);
});
