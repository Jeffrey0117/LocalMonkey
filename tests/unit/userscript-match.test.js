'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMatch,
  classifyExclude,
  excludeAppliesToHost,
  matchPathToGlob,
} = require('../../src/userscript/match.js');
const { matchGlob, MAX_PATTERN_LENGTH } = require('../../src/lib/glob.js');

/* ------------------------------------------------------------------ *
 * 路徑轉換。⛔ 這是整個 v2 最容易無聲做錯的地方：
 * Chrome match pattern 的 `*` 會跨 `/`，LocalMonkey 的 glob 單星號不跨。
 * ------------------------------------------------------------------ */

test('路徑 /* 轉成 match-all 特例 *', () => {
  assert.equal(matchPathToGlob('/*'), '*');
});

test('路徑 /items/* 轉成 /items/**（單星號不跨斜線，所以要補成雙星號）', () => {
  assert.equal(matchPathToGlob('/items/*'), '/items/**');
});

test('路徑中段的 * 也要變 **：/a/*/b → /a/**/b', () => {
  assert.equal(matchPathToGlob('/a/*/b'), '/a/**/b');
});

test('沒有萬用字元的路徑原樣保留', () => {
  assert.equal(matchPathToGlob('/exact'), '/exact');
  assert.equal(matchPathToGlob('/a/b/c.html'), '/a/b/c.html');
});

test('空路徑等於整站（*）', () => {
  assert.equal(matchPathToGlob(''), '*');
});

test('只有斜線的路徑就是首頁，不是整站', () => {
  assert.equal(matchPathToGlob('/'), '/');
});

test('沒有斜線分隔的 *：/items* → /items**', () => {
  assert.equal(matchPathToGlob('/items*'), '/items**');
});

test('原本就寫 ** 不會被放大成 ***', () => {
  assert.equal(matchPathToGlob('/a/**'), '/a/**');
  assert.equal(matchPathToGlob('/a/***'), '/a/**');
});

test('query 與 fragment 會被丟掉（注入判斷只看 pathname）', () => {
  assert.equal(matchPathToGlob('/search?q=*'), '/search');
  assert.equal(matchPathToGlob('/page#frag'), '/page');
});

test('轉換後的 glob 真的能比對到預期的路徑（跟 lib/glob.js 對帳）', () => {
  const itemsGlob = matchPathToGlob('/items/*');

  assert.equal(matchGlob(itemsGlob, '/items/42'), true);
  assert.equal(matchGlob(itemsGlob, '/items/42/detail'), true, 'Chrome 的 * 會跨斜線');
  assert.equal(matchGlob(itemsGlob, '/items'), false, 'Chrome 的 /items/* 也不配 /items');
  assert.equal(matchGlob(itemsGlob, '/other/42'), false);

  const nested = matchPathToGlob('/a/*/b');
  assert.equal(matchGlob(nested, '/a/x/b'), true);
  assert.equal(matchGlob(nested, '/a/x/y/z/b'), true, '跨斜線');
  assert.equal(matchGlob(nested, '/a/b'), false);

  assert.equal(matchGlob(matchPathToGlob('/*'), '/'), true);
  assert.equal(matchGlob(matchPathToGlob('/*'), '/anything/deep'), true);
  assert.equal(matchGlob(matchPathToGlob('/'), '/'), true);
  assert.equal(matchGlob(matchPathToGlob('/'), '/other'), false);
});

test('⛔ 回歸：如果有人把 @match 的路徑照抄成 glob，比對會壞掉（這就是要轉換的理由）', () => {
  // 照抄的話 `/items/*` 在我們的 glob 裡只配一層，/items/42/detail 就會漏掉
  assert.equal(matchGlob('/items/*', '/items/42/detail'), false);
  assert.equal(matchGlob(matchPathToGlob('/items/*'), '/items/42/detail'), true);
});

/* ------------------------------------------------------------------ *
 * 主機分類
 * ------------------------------------------------------------------ */

test('具體主機 → ready，組出 https target origin', () => {
  const result = classifyMatch('https://www.example.com/*');

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.host, 'www.example.com');
  assert.equal(result.scheme, 'https');
  assert.equal(result.targetOrigin, 'https://www.example.com');
  assert.equal(result.pathGlob, '*');
  assert.equal(result.insecure, false);
  assert.equal(result.reason, null);
});

test('萬用子網域 *.example.com → needs-host，提議 example.com', () => {
  const result = classifyMatch('https://*.example.com/items/*');

  assert.equal(result.proxyable, 'needs-host');
  assert.equal(result.host, 'example.com');
  assert.equal(result.wildcardHost, true);
  assert.equal(result.targetOrigin, 'https://example.com');
  assert.equal(result.pathGlob, '/items/**');
  assert.ok(result.reason.includes('子網域'), `reason 要說明原因：${result.reason}`);
});

test('<all_urls> → rejected，並說明反向代理必須指向具體主機', () => {
  const result = classifyMatch('<all_urls>');

  assert.equal(result.proxyable, 'rejected');
  assert.equal(result.host, null);
  assert.equal(result.targetOrigin, null);
  assert.ok(result.reason.length > 0);
  assert.ok(/具體主機|全世界/.test(result.reason), result.reason);
});

test('*://*/* → rejected', () => {
  const result = classifyMatch('*://*/*');
  assert.equal(result.proxyable, 'rejected');
  assert.ok(result.reason.length > 0);
});

test('主機就是一個 * → rejected', () => {
  assert.equal(classifyMatch('https://*/*').proxyable, 'rejected');
  assert.equal(classifyMatch('*').proxyable, 'rejected');
});

test('*:// 視為 https', () => {
  const result = classifyMatch('*://example.com/*');

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.scheme, 'https');
  assert.equal(result.insecure, false);
});

test('http:// 照收，但標示為不安全', () => {
  const result = classifyMatch('http://example.com/*');

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.scheme, 'http');
  assert.equal(result.targetOrigin, 'http://example.com');
  assert.equal(result.insecure, true);
});

test('file / ftp / chrome-extension 之類的 scheme → rejected', () => {
  for (const pattern of ['file:///C:/x/*', 'ftp://a.test/*', 'chrome-extension://abc/*']) {
    const result = classifyMatch(pattern);
    assert.equal(result.proxyable, 'rejected', pattern);
    assert.ok(result.reason.length > 0, pattern);
  }
});

test('主機中間有萬用字元（www.*.com）→ rejected，不要猜', () => {
  const result = classifyMatch('https://www.*.com/*');

  assert.equal(result.proxyable, 'rejected');
  assert.ok(/萬用|無法/.test(result.reason), result.reason);
});

test('主機帶 port 時保留 port', () => {
  const result = classifyMatch('http://localhost:3000/*');

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.host, 'localhost:3000');
  assert.equal(result.targetOrigin, 'http://localhost:3000');
});

test('主機大小寫正規化成小寫', () => {
  assert.equal(classifyMatch('https://WWW.Example.COM/*').host, 'www.example.com');
});

test('沒有路徑的 @match 等於整站', () => {
  const result = classifyMatch('https://example.com');

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.pathGlob, '*');
});

test('亂七八糟的輸入不會丟錯，一律 rejected 並附原因', () => {
  for (const pattern of ['', '   ', 'not a pattern', 'https://', '://x/*', null, undefined, 42]) {
    const result = classifyMatch(pattern);
    assert.equal(result.proxyable, 'rejected', JSON.stringify(pattern));
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  }
});

test('超長路徑（glob 長度超過 lib/glob.js 的上限）→ rejected', () => {
  const result = classifyMatch(`https://example.com/${'a'.repeat(MAX_PATTERN_LENGTH + 10)}`);

  assert.equal(result.proxyable, 'rejected');
  assert.ok(/長/.test(result.reason), result.reason);
});

/* ------------------------------------------------------------------ *
 * @include（更寬鬆）
 * ------------------------------------------------------------------ */

test('@include 沒有 scheme 也吃得下', () => {
  const result = classifyMatch('example.com/items/*', { kind: 'include' });

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.host, 'example.com');
  assert.equal(result.pathGlob, '/items/**');
});

test('@include 允許 *.example.com/* → needs-host', () => {
  const result = classifyMatch('*://*.example.com/*', { kind: 'include' });
  assert.equal(result.proxyable, 'needs-host');
  assert.equal(result.host, 'example.com');
});

test('@include 的 * 主機 → 照樣 rejected', () => {
  assert.equal(classifyMatch('*', { kind: 'include' }).proxyable, 'rejected');
  assert.equal(classifyMatch('http://*/*', { kind: 'include' }).proxyable, 'rejected');
});

test('正則形式的 @include：抽得出字面主機 → ready，但路徑放寬並留下警告', () => {
  const result = classifyMatch('/^https://www\\.example\\.com/items/\\d+/', { kind: 'include' });

  assert.equal(result.proxyable, 'ready');
  assert.equal(result.host, 'www.example.com');
  assert.equal(result.pathGlob, '*');
  assert.ok(result.warning && result.warning.length > 0, '放寬成整站這件事要講出來');
});

test('正則形式的 @include：抽不出主機 → rejected，而且不要猜', () => {
  for (const pattern of ['/^https?:\\/\\/.*\\/items/', '/\\w+\\.example\\.com/', '/.*/']) {
    const result = classifyMatch(pattern, { kind: 'include' });
    assert.equal(result.proxyable, 'rejected', pattern);
    assert.ok(/正則|無法|主機/.test(result.reason), `${pattern} → ${result.reason}`);
  }
});

/* ------------------------------------------------------------------ *
 * @exclude / @exclude_match
 * ------------------------------------------------------------------ */

test('@exclude 的萬用主機是合法的（排除條件放寬不危險）', () => {
  const result = classifyExclude('*://*/admin*');

  assert.equal(result.ok, true);
  assert.equal(result.hostScope.kind, 'any');
  assert.equal(result.pathGlob, '/admin**');
});

test('@exclude 指定具體主機時只套用在那個主機', () => {
  const result = classifyExclude('https://a.test/private/*');

  assert.equal(result.ok, true);
  assert.deepEqual(result.hostScope, { kind: 'host', host: 'a.test' });
  assert.equal(result.pathGlob, '/private/**');
});

test('@exclude 的 *.example.com 套用在該網域與其子網域', () => {
  const result = classifyExclude('https://*.example.com/x/*');

  assert.deepEqual(result.hostScope, { kind: 'suffix', domain: 'example.com' });
  assert.equal(excludeAppliesToHost(result.hostScope, 'example.com'), true);
  assert.equal(excludeAppliesToHost(result.hostScope, 'shop.example.com'), true);
  assert.equal(excludeAppliesToHost(result.hostScope, 'notexample.com'), false);
});

test('excludeAppliesToHost：any 套用在所有主機；host 只配完全相同', () => {
  assert.equal(excludeAppliesToHost({ kind: 'any' }, 'whatever.test'), true);
  assert.equal(excludeAppliesToHost({ kind: 'host', host: 'a.test' }, 'a.test'), true);
  assert.equal(excludeAppliesToHost({ kind: 'host', host: 'a.test' }, 'b.test'), false);
  assert.equal(excludeAppliesToHost({ kind: 'host', host: 'a.test' }, 'sub.a.test'), false);
});

test('@exclude 解析失敗 → ok:false 並附原因（不要變成「排除全部」）', () => {
  for (const pattern of ['', null, '/^regex/']) {
    const result = classifyExclude(pattern);
    assert.equal(result.ok, false, JSON.stringify(pattern));
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  }
});
