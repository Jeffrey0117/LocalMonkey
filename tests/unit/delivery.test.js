'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  newDeliveryToken,
  slugForScriptName,
  rewriteHeaderUrls,
  versionOf,
  bumpVersion,
  compareVersions,
  isVersionBumped,
} = require('../../src/services/delivery.js');
const { parseUserscript } = require('../../src/userscript/parse.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'real-userscripts');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.user.js`), 'utf8');
}

function script(lines, body = "console.log('x');") {
  return ['// ==UserScript==', ...lines, '// ==/UserScript==', '', body].join('\n');
}

/* ------------------------------ token ------------------------------ */

test('token 是 32 bytes 的隨機 hex，而且每次都不一樣', () => {
  const first = newDeliveryToken();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, newDeliveryToken());
});

/* ------------------------------ slug ------------------------------ */

test('slug 是給人看的檔名，中文會被收斂掉但不會變空的', () => {
  assert.equal(slugForScriptName('AutoReel IG Helper'), 'autoreel-ig-helper');
  assert.equal(slugForScriptName('XCard - X/Threads → Reelo'), 'xcard-x-threads-reelo');
  assert.ok(slugForScriptName('IG DM Peek（收件匣偷看）').length > 0);
  assert.equal(slugForScriptName('純中文名字'), 'userscript', '完全取不出字母數字就用通用名');
});

test('slug 不會出現能跑出路徑的字元', () => {
  for (const name of ['../../etc/passwd', 'a/b\\c', 'x?y#z', '  ', null]) {
    const slug = slugForScriptName(name);
    assert.match(slug, /^[a-z0-9-]+$/, `${name} → ${slug}`);
  }
});

/* --------------------------- header 改寫 --------------------------- */

const DELIVERY_URL = 'http://127.0.0.1:30600/s/aabbcc/demo.user.js';

test('⭐ 已經有 @updateURL / @downloadURL → 換成本端點的絕對網址', () => {
  const source = fixture('ig-helper');
  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);

  assert.equal(
    rewritten.includes('http://localhost:8001/scripts/ig-helper.user.js'),
    false,
    '舊的更新網址要被換掉，不然 Tampermonkey 還是去 localhost:8001 更新',
  );

  const parsed = parseUserscript(rewritten);
  assert.equal(parsed.updateUrl, DELIVERY_URL);
  assert.equal(parsed.downloadUrl, DELIVERY_URL);
});

test('⭐ 原本沒有這兩個 key → 補上去', () => {
  const source = fixture('peekly');
  assert.equal(parseUserscript(source).updateUrl, null);

  const parsed = parseUserscript(rewriteHeaderUrls(source, DELIVERY_URL));
  assert.equal(parsed.updateUrl, DELIVERY_URL);
  assert.equal(parsed.downloadUrl, DELIVERY_URL);
});

test('改寫不會動到 header 以外的任何一個 byte', () => {
  const source = fixture('xpost-card');
  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);

  const bodyOf = (text) => text.slice(text.indexOf('==/UserScript=='));
  assert.equal(bodyOf(rewritten), bodyOf(source));
});

test('改寫保住其他 header 欄位（名稱、match、grant、require 都還在）', () => {
  const before = parseUserscript(fixture('xpost-card'));
  const after = parseUserscript(rewriteHeaderUrls(fixture('xpost-card'), DELIVERY_URL));

  assert.equal(after.name, before.name);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.requires, before.requires);
  assert.deepEqual(after.connect, before.connect);
  assert.equal(after.targets.length, before.targets.length);
});

test('CRLF 的腳本改寫後還是 CRLF（原始樣本全部是 CRLF）', () => {
  const source = fixture('ig-helper');
  assert.ok(source.includes('\r\n'));

  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);
  assert.ok(rewritten.includes('\r\n'));
  assert.equal(/[^\r]\n/.test(rewritten.split('==/UserScript==')[0]), false, 'header 裡不該混進裸 \\n');
});

test('LF 的腳本改寫後還是 LF', () => {
  const source = script(['// @name x', '// @version 1.0']);
  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);

  assert.equal(rewritten.includes('\r\n'), false);
  assert.equal(parseUserscript(rewritten).updateUrl, DELIVERY_URL);
});

test('同一個 key 出現兩次 → 兩個都被換掉', () => {
  const source = script([
    '// @name x',
    '// @updateURL http://old.test/a.user.js',
    '// @updateURL http://older.test/a.user.js',
  ]);

  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);
  assert.equal(rewritten.includes('old.test'), false);
  assert.equal(rewritten.includes('older.test'), false);
});

test('大小寫不同的寫法（@updateurl）也換得掉', () => {
  const source = script(['// @name x', '// @updateurl http://old.test/a.user.js']);
  const rewritten = rewriteHeaderUrls(source, DELIVERY_URL);

  assert.equal(rewritten.includes('old.test'), false);
  assert.equal(parseUserscript(rewritten).updateUrl, DELIVERY_URL);
});

test('沒有 metadata block → 原樣回傳（沒有安裝清單可以改）', () => {
  const source = "document.title = 'x';";
  assert.equal(rewriteHeaderUrls(source, DELIVERY_URL), source);
});

test('非字串輸入不會炸', () => {
  for (const input of [null, undefined, 42]) {
    assert.doesNotThrow(() => rewriteHeaderUrls(input, DELIVERY_URL));
  }
});

/* ------------------------------ 版本 ------------------------------ */

test('versionOf 讀得出 @version，沒有就是 null', () => {
  assert.equal(versionOf(fixture('ig-helper')), '1.13.6');
  assert.equal(versionOf(fixture('peekly')), '4.0');
  assert.equal(versionOf("console.log('x');"), null);
});

test('compareVersions 照數字段比，不是字串比', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1, '10 要大於 9（字串比會反過來）');
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.3', '1.2.9'), 1);
  assert.equal(compareVersions('2.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺的段當 0');
});

test('compareVersions：null / 怪字串不會炸', () => {
  assert.equal(compareVersions(null, '1.0'), -1);
  assert.equal(compareVersions('1.0', null), 1);
  assert.equal(compareVersions(null, null), 0);
  assert.doesNotThrow(() => compareVersions('beta', '1.0'));
});

test('⭐ bumpVersion：最後一段數字 +1', () => {
  assert.equal(versionOf(bumpVersion(script(['// @version 1.2.3']))), '1.2.4');
  assert.equal(versionOf(bumpVersion(script(['// @version 4.0']))), '4.1');
  assert.equal(versionOf(bumpVersion(script(['// @version 0.1.0']))), '0.1.1');
  assert.equal(versionOf(bumpVersion(script(['// @version 1.13.6']))), '1.13.7');
});

test('⭐ bumpVersion：原本沒有 @version → 補 1.0.0', () => {
  const bumped = bumpVersion(script(['// @name 沒有版本號']));

  assert.equal(versionOf(bumped), '1.0.0');
  assert.equal(parseUserscript(bumped).name, '沒有版本號', '其他欄位不能被弄壞');
});

test('bumpVersion：版本號沒有數字結尾 → 接上 .1（不要把使用者寫的東西丟掉）', () => {
  assert.equal(versionOf(bumpVersion(script(['// @version beta']))), 'beta.1');
});

test('bumpVersion 的結果一定比原本大', () => {
  for (const version of ['1.2.3', '4.0', '0.1.0', '1.13.6', '3.0.1', '10.9']) {
    const before = version;
    const after = versionOf(bumpVersion(script([`// @version ${version}`])));
    assert.equal(compareVersions(after, before), 1, `${before} → ${after}`);
  }
});

test('bumpVersion 對真實腳本也成立，而且不動 header 以外的東西', () => {
  for (const name of ['ig-helper', 'xpost-card', 'peekly', 'revid-subs']) {
    const source = fixture(name);
    const bumped = bumpVersion(source);

    assert.equal(compareVersions(versionOf(bumped), versionOf(source)), 1, name);

    const bodyOf = (text) => text.slice(text.indexOf('==/UserScript=='));
    assert.equal(bodyOf(bumped), bodyOf(source), `${name} 的本文被動到了`);
  }
});

test('bumpVersion：沒有 metadata block → 原樣回傳', () => {
  const source = "document.title = 'x';";
  assert.equal(bumpVersion(source), source);
});

/* --------------------------- 版本有沒有往上 --------------------------- */

test('⭐ isVersionBumped：沒變 / 變小 → false（Tampermonkey 不會更新）', () => {
  assert.equal(isVersionBumped('1.2.3', '1.2.3'), false);
  assert.equal(isVersionBumped('1.2.3', '1.2.2'), false);
  assert.equal(isVersionBumped('1.2.3', '1.2.4'), true);
});

test('isVersionBumped：本來沒有版本號 → 新增了就算往上', () => {
  assert.equal(isVersionBumped(null, '1.0.0'), true);
  assert.equal(isVersionBumped(null, null), false, '兩邊都沒有 = 永遠不會自動更新');
  assert.equal(isVersionBumped('1.0.0', null), false, '把版本號刪掉不算往上');
});
