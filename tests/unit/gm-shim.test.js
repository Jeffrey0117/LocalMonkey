'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { renderShim } = require('../../src/lib/gm-shim.js');
const { createFakeDom } = require('../support/dom.js');

/*
 * ⚠ shim 在 vm context 裡跑，它回傳的陣列是**那個 realm 的 Array**，
 * 跟宿主的 Array 不是同一個 prototype → assert.deepEqual 會以
 * 「same structure but not reference-equal」失敗。所以比對前先 Array.from 轉回來。
 */

function config(overrides = {}) {
  return {
    scriptId: 'scr_aaaa',
    name: '測試腳本',
    version: '1.2',
    namespace: 'https://example.com',
    description: '說明',
    runAt: 'document-end',
    grants: ['GM_setValue', 'GM_getValue'],
    unsupported: [],
    connect: [],
    resources: {},
    xhrEndpoint: '/__lm/gm/xhr',
    ...overrides,
  };
}

function install(dom, shimConfig) {
  vm.createContext(dom.sandbox);
  new vm.Script(renderShim(shimConfig)).runInContext(dom.sandbox);
  return dom.window.__localMonkey.apis[shimConfig.scriptId];
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('只暴露 @grant 列出的 API（沒 grant 的不要給）', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_setValue', 'GM_addStyle'] }));

  assert.equal(typeof api.GM_setValue, 'function');
  assert.equal(typeof api.GM_addStyle, 'function');
  assert.equal('GM_getValue' in api, false, '沒 grant 的不該出現');
  assert.equal('GM_xmlhttpRequest' in api, false);
});

test('unsafeWindow 就是 window（我們本來就在頁面 scope）', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['unsafeWindow'] }));

  assert.equal(api.unsafeWindow, dom.window);
});

test('GM_addStyle 把 <style> 塞進 head 並回傳該元素', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_addStyle'] }));

  const element = api.GM_addStyle('body { color: red }');

  assert.equal(element.tagName, 'STYLE');
  assert.equal(element.textContent, 'body { color: red }');
  assert.ok(dom.head.children.includes(element));
});

test('GM_addStyle 在沒有 head 的文件上退到 documentElement', () => {
  const dom = createFakeDom();
  dom.document.head = null;
  const api = install(dom, config({ grants: ['GM_addStyle'] }));

  const element = api.GM_addStyle('p{}');

  assert.ok(dom.document.documentElement.children.includes(element));
});

test('GM_setValue / GM_getValue：同步、帶前綴、保留型別', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({ grants: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'] }),
  );

  api.GM_setValue('count', 42);
  api.GM_setValue('flag', true);
  api.GM_setValue('obj', { a: [1, 2] });
  api.GM_setValue('text', '字串');

  assert.equal(api.GM_getValue('count'), 42);
  assert.equal(api.GM_getValue('flag'), true);
  assert.deepEqual(api.GM_getValue('obj'), { a: [1, 2] });
  assert.equal(api.GM_getValue('text'), '字串');

  assert.ok(
    [...dom.storage.map.keys()].every((key) => key.startsWith('__lm_gm_scr_aaaa_')),
    `key 要帶腳本前綴：${[...dom.storage.map.keys()].join(',')}`,
  );
});

test('GM_getValue 沒存過就回預設值', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_getValue'] }));

  assert.equal(api.GM_getValue('nope'), undefined);
  assert.equal(api.GM_getValue('nope', 'fallback'), 'fallback');
});

test('GM_deleteValue / GM_listValues 只看自己的命名空間', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({ grants: ['GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues'] }),
  );

  dom.storage.setItem('__lm_gm_scr_other_theirs', '"x"');
  dom.storage.setItem('unrelated', 'y');

  api.GM_setValue('mine', 1);
  api.GM_setValue('mine2', 2);

  assert.deepEqual(Array.from(api.GM_listValues()).sort(), ['mine', 'mine2']);

  api.GM_deleteValue('mine');
  assert.deepEqual(Array.from(api.GM_listValues()), ['mine2']);
  assert.equal(dom.storage.getItem('__lm_gm_scr_other_theirs'), '"x"', '不准動別支腳本的值');
  assert.equal(dom.storage.getItem('unrelated'), 'y', '不准動原站自己的 localStorage');
});

test('兩支腳本的值彼此看不到', () => {
  const dom = createFakeDom();
  const first = install(dom, config({ scriptId: 'scr_one', grants: ['GM_setValue', 'GM_listValues'] }));
  const second = install(dom, config({ scriptId: 'scr_two', grants: ['GM_setValue', 'GM_listValues'] }));

  first.GM_setValue('a', 1);
  second.GM_setValue('b', 2);

  assert.deepEqual(Array.from(first.GM_listValues()), ['a']);
  assert.deepEqual(Array.from(second.GM_listValues()), ['b']);
});

test('localStorage 被停用時不丟錯，只 warn 並回預設值', () => {
  const dom = createFakeDom({ storage: 'throws' });
  const api = install(dom, config({ grants: ['GM_setValue', 'GM_getValue', 'GM_listValues'] }));

  assert.doesNotThrow(() => api.GM_setValue('a', 1));
  assert.equal(api.GM_getValue('a', 'fallback'), 'fallback');
  assert.deepEqual(Array.from(api.GM_listValues()), []);
  assert.ok(dom.warnings.length > 0, 'shim 自己的錯誤要進 console.warn');
});

test('GM4 的點號形式：api.GM.setValue 回 Promise', async () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM.setValue', 'GM.getValue'] }));

  assert.equal(typeof api.GM, 'object');

  const result = api.GM.setValue('k', 'v');
  assert.ok(result instanceof Promise || typeof result.then === 'function');
  await result;

  assert.equal(await api.GM.getValue('k'), 'v');
});

test('GM_openInTab 開新視窗', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_openInTab'] }));

  const handle = api.GM_openInTab('https://example.com/x');

  assert.deepEqual(dom.opened[0].url, 'https://example.com/x');
  assert.equal(typeof handle.close, 'function');
});

test('GM_setClipboard 成功時寫進剪貼簿', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_setClipboard'] }));

  const result = api.GM_setClipboard('複製我');

  assert.deepEqual(dom.clipboardWrites, ['複製我']);
  assert.equal(result, true);
});

test('GM_setClipboard 失敗時回 false 並 warn，不往外丟錯', async () => {
  const dom = createFakeDom({ clipboard: 'fail' });
  const api = install(dom, config({ grants: ['GM_setClipboard'] }));

  assert.doesNotThrow(() => api.GM_setClipboard('x'));
  await flush();
  assert.ok(dom.warnings.length > 0);
});

test('沒有 navigator.clipboard 的環境回 false', () => {
  const dom = createFakeDom({ clipboard: 'missing' });
  const api = install(dom, config({ grants: ['GM_setClipboard'] }));

  assert.equal(api.GM_setClipboard('x'), false);
});

test('GM_registerMenuCommand 建一顆隔離樣式的浮動按鈕', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_registerMenuCommand'] }));

  let called = 0;
  const id = api.GM_registerMenuCommand('做一件事', () => {
    called += 1;
  });

  assert.ok(id);

  const container = dom.body.children.find((child) => child.attributes['data-localmonkey'] === 'menu');
  assert.ok(container, '選單容器要掛上去');
  assert.equal(container.style.all, 'initial', '樣式要隔離，避免被原站 CSS 汙染');
  assert.ok(Number(container.style.zIndex) > 0);

  // 展開選單 → 點下去要呼叫到 callback
  const toggle = container.children[0];
  toggle.dispatch('click', {});
  const entries = container.children.filter((child) => child.attributes['data-lm-command']);
  assert.equal(entries.length, 1);
  entries[0].dispatch('click', {});
  assert.equal(called, 1);
});

test('GM_notification 有權限時用 Notification', () => {
  const dom = createFakeDom({ notification: 'granted' });
  const api = install(dom, config({ grants: ['GM_notification'] }));

  api.GM_notification({ title: '標題', text: '內容' });

  assert.equal(dom.notifications.length, 1);
  assert.equal(dom.notifications[0].title, '標題');
});

test('GM_notification 沒權限時退回頁面內 toast，不丟錯', () => {
  const dom = createFakeDom({ notification: 'denied' });
  const api = install(dom, config({ grants: ['GM_notification'] }));

  assert.doesNotThrow(() => api.GM_notification('只有文字'));
  assert.equal(dom.notifications.length, 0);

  const toast = dom.body.children.find((child) => child.attributes['data-localmonkey'] === 'toast');
  assert.ok(toast, '要有頁面內的替代提示');
  assert.equal(toast.style.all, 'initial');
});

test('完全沒有 Notification 的環境也只是 toast', () => {
  const dom = createFakeDom({ notification: 'missing' });
  const api = install(dom, config({ grants: ['GM_notification'] }));

  assert.doesNotThrow(() => api.GM_notification('x'));
  assert.ok(dom.body.children.some((child) => child.attributes['data-localmonkey'] === 'toast'));
});

test('GM_info 從 metadata 合成', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({ grants: ['GM_info'], matches: ['https://a.test/*'], excludes: ['/admin'] }),
  );

  assert.equal(api.GM_info.script.name, '測試腳本');
  assert.equal(api.GM_info.script.version, '1.2');
  assert.equal(api.GM_info.script.namespace, 'https://example.com');
  assert.deepEqual(Array.from(api.GM_info.script.matches), ['https://a.test/*']);
  assert.equal(api.GM_info.scriptHandler, 'LocalMonkey');
  assert.equal(api.GM_info.script.runAt, 'document-end');
});

test('GM_getResourceText / GM_getResourceURL 走伺服器端快取', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({
      grants: ['GM_getResourceText', 'GM_getResourceURL'],
      resources: {
        theme: { url: 'https://cdn.test/t.css', sha256: 'a'.repeat(64), assetUrl: `/__lm/asset/${'a'.repeat(64)}`, text: 'body{}' },
      },
    }),
  );

  assert.equal(api.GM_getResourceText('theme'), 'body{}');
  assert.equal(api.GM_getResourceURL('theme'), `/__lm/asset/${'a'.repeat(64)}`);
});

test('GM_getResourceText 找不到名稱 → null 並 warn（不要丟錯弄壞腳本）', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_getResourceText', 'GM_getResourceURL'] }));

  assert.equal(api.GM_getResourceText('nope'), null);
  assert.equal(api.GM_getResourceURL('nope'), null);
  assert.ok(dom.warnings.length > 0);
});

test('GM_xmlhttpRequest 走伺服器端轉發，並把回應組成 Tampermonkey 的形狀', async () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_xmlhttpRequest'], connect: ['api.example.com'] }));

  const loaded = [];
  api.GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.example.com/x',
    headers: { 'content-type': 'application/json' },
    data: '{"a":1}',
    onload: (response) => loaded.push(response),
  });

  await flush();

  assert.equal(dom.fetchCalls.length, 1);
  assert.equal(dom.fetchCalls[0].url, '/__lm/gm/xhr');
  assert.equal(dom.fetchCalls[0].init.method, 'POST');
  assert.equal(dom.fetchCalls[0].init.credentials, 'same-origin');

  const sent = JSON.parse(dom.fetchCalls[0].init.body);
  assert.equal(sent.scriptId, 'scr_aaaa');
  assert.equal(sent.url, 'https://api.example.com/x');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.data, '{"a":1}');

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].status, 200);
  assert.equal(loaded[0].responseText, 'from upstream');
  assert.equal(loaded[0].response, 'from upstream');
  assert.equal(loaded[0].readyState, 4);
  assert.equal(loaded[0].finalUrl, 'https://api.example.com/x');
  assert.match(loaded[0].responseHeaders, /content-type: text\/plain/);
});

test('GM_xmlhttpRequest 被伺服器擋下來時呼叫 onerror，而且不丟錯', async () => {
  const dom = createFakeDom();
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'connect_not_allowed', message: '不在 @connect 裡' }) });
  dom.sandbox.fetch = dom.window.fetch;

  const api = install(dom, config({ grants: ['GM_xmlhttpRequest'] }));

  const errors = [];
  assert.doesNotThrow(() =>
    api.GM_xmlhttpRequest({ url: 'https://evil.test/x', onerror: (error) => errors.push(error) }),
  );

  await flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 403);
  assert.match(String(errors[0].error ?? errors[0].message ?? ''), /connect|@connect/);
});

test('GM_xmlhttpRequest 連 fetch 本身都炸掉也只進 onerror', async () => {
  const dom = createFakeDom();
  dom.window.fetch = () => Promise.reject(new Error('network down'));
  dom.sandbox.fetch = dom.window.fetch;

  const api = install(dom, config({ grants: ['GM_xmlhttpRequest'] }));

  const errors = [];
  api.GM_xmlhttpRequest({ url: 'https://api.example.com/x', onerror: (error) => errors.push(error) });
  await flush();

  assert.equal(errors.length, 1);
});

test('GM_xmlhttpRequest 回傳的物件有 abort（腳本常常會呼叫）', () => {
  const dom = createFakeDom();
  const api = install(dom, config({ grants: ['GM_xmlhttpRequest'] }));

  const handle = api.GM_xmlhttpRequest({ url: 'https://api.example.com/x' });
  assert.equal(typeof handle.abort, 'function');
  assert.doesNotThrow(() => handle.abort());
});

test('不支援的 GM API → 會 console.error 的 stub（不是靜默失敗、也不是丟錯）', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({ grants: ['GM_download', 'GM_cookie'], unsupported: ['GM_download', 'GM_cookie'] }),
  );

  assert.equal(typeof api.GM_download, 'function');
  assert.doesNotThrow(() => api.GM_download('https://x.test/a.zip'));

  assert.equal(dom.errors.length, 1);
  assert.match(dom.errors[0][0], /尚未支援 GM_download/);
});

test('shim 被載入兩次不會把第一支腳本的 api 清掉', () => {
  const dom = createFakeDom();
  const first = install(dom, config({ scriptId: 'scr_one', grants: ['GM_setValue', 'GM_getValue'] }));
  install(dom, config({ scriptId: 'scr_two', grants: ['GM_setValue'] }));

  first.GM_setValue('k', 'v');
  assert.equal(dom.window.__localMonkey.apis.scr_one.GM_getValue('k'), 'v');
  assert.ok(dom.window.__localMonkey.apis.scr_two);
});

test('config 裡的奇怪 grant 名稱不會變成程式碼（只收合法識別字）', () => {
  const dom = createFakeDom();
  const api = install(
    dom,
    config({ grants: ['GM_setValue', 'x; window.PWNED = 1;', '', null], unsupported: [] }),
  );

  assert.equal(dom.window.PWNED, undefined);
  assert.equal(typeof api.GM_setValue, 'function');
});

test('shim 自己完全不碰頁面的全域名字（只掛一個 __localMonkey）', () => {
  const dom = createFakeDom();
  install(dom, config({ grants: ['GM_setValue'] }));

  const added = Object.keys(dom.window).filter(
    (key) => !['document', 'location', 'localStorage', 'open', 'setTimeout', 'clearTimeout', 'requestIdleCallback', 'navigator', 'fetch', 'Notification', 'window', 'self'].includes(key),
  );

  assert.deepEqual(added, ['__localMonkey']);
});
