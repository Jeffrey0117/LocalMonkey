'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseUserscript } = require('../../src/userscript/parse.js');

function script(lines, body = "console.log('x');") {
  return ['// ==UserScript==', ...lines, '// ==/UserScript==', '', body].join('\n');
}

test('完整 header：名稱、版本、描述、作者都抓得到', () => {
  const parsed = parseUserscript(
    script([
      '// @name        蝦皮去廣告',
      '// @version     2.1',
      '// @description 把首頁的推薦廣告拿掉',
      '// @author      Jeff',
      '// @namespace   https://example.com',
      '// @icon        https://example.com/icon.png',
      '// @match       https://shopee.tw/*',
    ]),
  );

  assert.equal(parsed.hasMetadataBlock, true);
  assert.equal(parsed.name, '蝦皮去廣告');
  assert.equal(parsed.version, '2.1');
  assert.equal(parsed.description, '把首頁的推薦廣告拿掉');
  assert.equal(parsed.author, 'Jeff');
  assert.equal(parsed.namespace, 'https://example.com');
  assert.equal(parsed.icon, 'https://example.com/icon.png');
});

test('沒有 metadata block：不拒收，當成純 JS 片段並留下提示', () => {
  const parsed = parseUserscript("document.title = 'x';");

  assert.equal(parsed.hasMetadataBlock, false);
  assert.equal(parsed.name, '未命名腳本');
  assert.deepEqual(parsed.targets, []);
  assert.equal(parsed.runAt, 'document-end');
  assert.ok(
    parsed.notices.some((notice) => /header/.test(notice.message)),
    `要告訴使用者沒有 header：${JSON.stringify(parsed.notices)}`,
  );
});

test('沒有 @name 時用 fallbackName（通常是檔名）', () => {
  const parsed = parseUserscript(script(['// @match https://a.test/*']), {
    fallbackName: 'my-tool.user.js',
  });

  assert.equal(parsed.name, 'my-tool.user.js');
});

test('@name 空白或只有空格 → 退回 fallback', () => {
  const parsed = parseUserscript(script(['// @name    ', '// @match https://a.test/*']));
  assert.equal(parsed.name, '未命名腳本');
});

test('@run-at 三個值都支援，預設 document-end', () => {
  assert.equal(parseUserscript(script(['// @run-at document-start'])).runAt, 'document-start');
  assert.equal(parseUserscript(script(['// @run-at document-end'])).runAt, 'document-end');
  assert.equal(parseUserscript(script(['// @run-at document-idle'])).runAt, 'document-idle');
  assert.equal(parseUserscript(script(['// @name x'])).runAt, 'document-end');
});

test('@run-at document-body 對應到 document-end 並留下提示', () => {
  const parsed = parseUserscript(script(['// @run-at document-body']));

  assert.equal(parsed.runAt, 'document-end');
  assert.ok(parsed.notices.some((notice) => /document-body/.test(notice.message)));
});

test('@run-at 寫了不認識的值 → 退回預設並留下提示', () => {
  const parsed = parseUserscript(script(['// @run-at whenever']));

  assert.equal(parsed.runAt, 'document-end');
  assert.ok(parsed.notices.some((notice) => notice.level === 'warn'));
});

test('@grant 收成清單，並分成支援與不支援兩堆', () => {
  const parsed = parseUserscript(
    script([
      '// @grant GM_setValue',
      '// @grant GM_getValue',
      '// @grant GM_addStyle',
      '// @grant GM_cookie',
      '// @grant GM_fakeThing',
    ]),
  );

  assert.deepEqual(parsed.grants, [
    'GM_setValue',
    'GM_getValue',
    'GM_addStyle',
    'GM_cookie',
    'GM_fakeThing',
  ]);
  assert.deepEqual(parsed.supportedGrants, ['GM_setValue', 'GM_getValue', 'GM_addStyle']);
  assert.deepEqual(parsed.unsupportedGrants, ['GM_cookie', 'GM_fakeThing']);
  assert.equal(parsed.needsShim, true);
  assert.ok(
    parsed.notices.some((notice) => notice.level === 'error' && /GM_cookie/.test(notice.message)),
    '不支援的 GM API 要用紅字講出來',
  );
});

test('@grant none → 不投遞 shim', () => {
  const parsed = parseUserscript(script(['// @grant none', '// @match https://a.test/*']));

  assert.equal(parsed.grantNone, true);
  assert.equal(parsed.needsShim, false);
  assert.deepEqual(parsed.grants, []);
});

test('完全沒有 @grant → 不投遞 shim', () => {
  const parsed = parseUserscript(script(['// @match https://a.test/*']));

  assert.equal(parsed.grantNone, false);
  assert.equal(parsed.needsShim, false);
});

test('重複的 @grant 去重，大小寫保留原樣', () => {
  const parsed = parseUserscript(script(['// @grant GM_setValue', '// @grant GM_setValue']));
  assert.deepEqual(parsed.grants, ['GM_setValue']);
});

test('GM.setValue（GM4 點號形式）也算支援', () => {
  const parsed = parseUserscript(script(['// @grant GM.setValue', '// @grant GM.xmlHttpRequest']));

  assert.deepEqual(parsed.unsupportedGrants, []);
  assert.equal(parsed.needsShim, true);
});

test('unsafeWindow 是合法的 grant', () => {
  const parsed = parseUserscript(script(['// @grant unsafeWindow']));

  assert.deepEqual(parsed.supportedGrants, ['unsafeWindow']);
  assert.deepEqual(parsed.unsupportedGrants, []);
});

test('@connect 收成清單；@connect * 要標成「拒絕」', () => {
  const plain = parseUserscript(script(['// @connect api.example.com', '// @connect cdn.test']));
  assert.deepEqual(plain.connect, ['api.example.com', 'cdn.test']);
  assert.equal(plain.connectAll, false);

  const all = parseUserscript(script(['// @connect *']));
  assert.equal(all.connectAll, true);
  assert.ok(
    all.notices.some((notice) => notice.level === 'error' && /@connect/.test(notice.message)),
    '@connect * 要說明必須列出具體主機',
  );
});

test('@require 保持宣告順序並去重', () => {
  const parsed = parseUserscript(
    script([
      '// @require https://cdn.test/a.js',
      '// @require https://cdn.test/b.js',
      '// @require https://cdn.test/a.js',
    ]),
  );

  assert.deepEqual(parsed.requires, ['https://cdn.test/a.js', 'https://cdn.test/b.js']);
});

test('@require 不是 http(s) 網址 → 丟掉並留下提示', () => {
  const parsed = parseUserscript(script(['// @require file:///C:/x.js', '// @require 隨便打的']));

  assert.deepEqual(parsed.requires, []);
  assert.equal(parsed.notices.filter((notice) => /@require/.test(notice.message)).length, 2);
});

test('@resource 解析成 name + url', () => {
  const parsed = parseUserscript(
    script(['// @resource logo https://cdn.test/logo.png', '// @resource css  https://cdn.test/a.css']),
  );

  assert.deepEqual(parsed.resources, [
    { name: 'logo', url: 'https://cdn.test/logo.png' },
    { name: 'css', url: 'https://cdn.test/a.css' },
  ]);
});

test('@resource 少了 url → 丟掉並留下提示', () => {
  const parsed = parseUserscript(script(['// @resource onlyname']));

  assert.deepEqual(parsed.resources, []);
  assert.ok(parsed.notices.some((notice) => /@resource/.test(notice.message)));
});

test('@noframes 是布林', () => {
  assert.equal(parseUserscript(script(['// @noframes'])).noframes, true);
  assert.equal(parseUserscript(script(['// @name x'])).noframes, false);
});

test('@match 與 @include 合併成 targets，各自標 kind', () => {
  const parsed = parseUserscript(
    script([
      '// @match   https://www.example.com/*',
      '// @match   https://seller.example.com/items/*',
      '// @include https://legacy.example.com/*',
    ]),
  );

  assert.equal(parsed.targets.length, 3);
  assert.deepEqual(
    parsed.targets.map((target) => target.host),
    ['www.example.com', 'seller.example.com', 'legacy.example.com'],
  );
  assert.deepEqual(
    parsed.targets.map((target) => target.kind),
    ['match', 'match', 'include'],
  );
  assert.deepEqual(
    parsed.targets.map((target) => target.pathGlob),
    ['*', '/items/**', '*'],
  );
});

test('同一個主機被兩個 @match 指到 → 兩筆 target（路徑不同）', () => {
  const parsed = parseUserscript(
    script(['// @match https://a.test/shop/*', '// @match https://a.test/user/*']),
  );

  assert.equal(parsed.targets.length, 2);
  assert.deepEqual(
    parsed.targets.map((target) => target.pathGlob),
    ['/shop/**', '/user/**'],
  );
});

test('完全重複的 @match 去重', () => {
  const parsed = parseUserscript(
    script(['// @match https://a.test/*', '// @match https://a.test/*']),
  );

  assert.equal(parsed.targets.length, 1);
});

test('全部 target 都被拒 → 提示要說「代理不行但投遞可以」，而不是「不支援」', () => {
  const parsed = parseUserscript(script(['// @match <all_urls>']));

  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0].proxyable, 'rejected');
  assert.equal(parsed.targets[0].deliverable, true);

  const notice = parsed.notices.find((entry) => /投遞模式/.test(entry.message));
  assert.ok(notice, `提示要指出投遞模式這條路：${JSON.stringify(parsed.notices)}`);
  assert.equal(notice.level, 'warn', '代理配不起來不是錯誤 —— 這支腳本照樣能用');
});

test('@exclude 與 @exclude_match 都收，解析失敗的不會變成排除全部', () => {
  const parsed = parseUserscript(
    script([
      '// @match https://a.test/*',
      '// @exclude https://a.test/admin/*',
      '// @exclude_match *://*/login',
      '// @exclude /^regex/',
    ]),
  );

  assert.equal(parsed.excludes.length, 2);
  assert.deepEqual(
    parsed.excludes.map((exclude) => exclude.pathGlob),
    ['/admin/**', '/login'],
  );
  assert.ok(parsed.notices.some((notice) => /@exclude/.test(notice.message)));
});

test('解析結果是凍結的（單一真相來源不該被呼叫端改掉）', () => {
  const parsed = parseUserscript(script(['// @match https://a.test/*']));

  assert.throws(() => {
    parsed.name = '被改掉';
  }, TypeError);
  assert.throws(() => {
    parsed.targets.push({});
  }, TypeError);
});

test('非字串輸入不會炸', () => {
  for (const input of [null, undefined, 42, {}]) {
    const parsed = parseUserscript(input);
    assert.equal(parsed.hasMetadataBlock, false);
    assert.deepEqual(parsed.targets, []);
  }
});

test('metadata 可以安全地 JSON 來回（要存進 DB 的 metadata 欄位）', () => {
  const parsed = parseUserscript(
    script(['// @name 測試', '// @match https://a.test/*', '// @grant GM_setValue']),
  );

  const roundTripped = JSON.parse(JSON.stringify(parsed));
  assert.equal(roundTripped.name, '測試');
  assert.equal(roundTripped.targets[0].host, 'a.test');
  assert.deepEqual(roundTripped.grants, ['GM_setValue']);
});
