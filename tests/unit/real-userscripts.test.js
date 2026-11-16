'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseUserscript } = require('../../src/userscript/parse.js');

/**
 * 使用者實際要丟進來的 7 支腳本（header 區塊存在 fixtures/real-userscripts/）。
 *
 * 這些比自己編的測資有價值：它們決定了預設值對不對、哪條路徑是主流、
 * 哪些 key 不能漏。原始檔是 CRLF、滿滿中文與 emoji，fixture 原樣保留。
 */

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'real-userscripts');

function load(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.user.js`), 'utf8');
}

function parse(name) {
  return parseUserscript(load(name), { fallbackName: `${name}.user.js` });
}

const ALL = [
  'ig-comment-scraper',
  'ig-dm-sender',
  'ig-helper',
  'threads-helper',
  'xpost-card',
  'peekly',
  'revid-subs',
];

test('七支都解析得出 header，而且名稱不是退回檔名', () => {
  for (const name of ALL) {
    const parsed = parse(name);
    assert.equal(parsed.hasMetadataBlock, true, name);
    assert.notEqual(parsed.name, `${name}.user.js`, `${name} 的 @name 沒抓到`);
    assert.ok(parsed.version, `${name} 少了 @version`);
  }
});

test('中文、全形括號、emoji、超長 description 都原樣保留', () => {
  const scraper = parse('ig-comment-scraper');

  assert.equal(scraper.name, 'AutoReel IG 留言關鍵字抓取');
  assert.ok(scraper.description.includes('⚠️'), 'emoji 要留著');
  assert.ok(scraper.description.includes('「留言含關鍵字」'), '全形引號要留著');
  assert.ok(scraper.description.length > 60, `description 被截斷了：${scraper.description.length}`);

  const helper = parse('ig-helper');
  assert.ok(helper.description.includes('(v1.7.9 base + 你 v1.8.x 觸發 IG 睡, 回 v1.7 鎖屏)'));
});

test('CRLF 的檔案不會在值的結尾殘留 \\r', () => {
  for (const name of ALL) {
    const parsed = parse(name);
    assert.equal(/\r/.test(parsed.name), false, `${name} 的 name 有 \\r`);
    assert.equal(/\r/.test(parsed.version), false, `${name} 的 version 有 \\r`);
    for (const target of parsed.targets) {
      assert.equal(/\r/.test(target.pattern), false, `${name} 的 pattern 有 \\r`);
    }
  }
});

test('@run-at 的實際分布：document-idle 是多數，沒有人用 document-start', () => {
  const runAts = ALL.map((name) => parse(name).runAt);

  assert.equal(runAts.filter((runAt) => runAt === 'document-idle').length, 4);
  assert.equal(runAts.filter((runAt) => runAt === 'document-end').length, 3, '沒寫的退回預設');
  assert.equal(runAts.filter((runAt) => runAt === 'document-start').length, 0);
});

test('@grant none 的四支不該被投遞 shim', () => {
  for (const name of ['ig-comment-scraper', 'ig-dm-sender', 'peekly', 'revid-subs']) {
    const parsed = parse(name);
    assert.equal(parsed.grantNone, true, name);
    assert.equal(parsed.needsShim, false, name);
    assert.deepEqual(parsed.grants, [], name);
  }
});

test('GM_xmlhttpRequest 是三支在用的主流 API，而且全部被判為支援', () => {
  const users = ALL.filter((name) => parse(name).grants.includes('GM_xmlhttpRequest'));

  assert.deepEqual(users, ['ig-helper', 'threads-helper', 'xpost-card']);
  for (const name of users) {
    assert.deepEqual(parse(name).unsupportedGrants, [], `${name} 不該有未支援的 GM API`);
  }
});

test('⭐ 七支裡沒有任何一支用到「我們不支援」的 GM API', () => {
  for (const name of ALL) {
    const parsed = parse(name);
    assert.deepEqual(
      parsed.unsupportedGrants,
      [],
      `${name} 用到 ${parsed.unsupportedGrants.join('、')} —— 要嘛實作它，要嘛在 UI 標紅字`,
    );
  }
});

test('@connect localhost：三支都是「不帶 port」的宣告', () => {
  for (const name of ['ig-helper', 'threads-helper', 'xpost-card']) {
    assert.ok(parse(name).connect.includes('localhost'), name);
  }
});

test('@connect 的其他主機：裸網域是用來涵蓋子網域的', () => {
  const parsed = parse('xpost-card');

  assert.deepEqual(parsed.connect, [
    'translate.googleapis.com',
    'pbs.twimg.com',
    'fbcdn.net',
    'cdninstagram.com',
    'localhost',
  ]);
  assert.equal(parsed.connectAll, false, '沒有人用 @connect *');
});

test('@noframes 只有 ig-helper 宣告', () => {
  assert.equal(parse('ig-helper').noframes, true);
  for (const name of ALL.filter((candidate) => candidate !== 'ig-helper')) {
    assert.equal(parse(name).noframes, false, name);
  }
});

test('@updateURL / @downloadURL 要解析進 metadata，不能丟掉', () => {
  for (const name of ['ig-helper', 'xpost-card']) {
    const parsed = parse(name);
    assert.equal(
      parsed.updateUrl,
      `http://localhost:8001/scripts/${name}.user.js`,
      `${name} 的 @updateURL`,
    );
    assert.equal(parsed.downloadUrl, `http://localhost:8001/scripts/${name}.user.js`);
  }

  assert.equal(parse('peekly').updateUrl, null, '沒宣告就是 null');
});

test('@require 是真的 CDN 網址，順序要保住', () => {
  const parsed = parse('xpost-card');

  assert.deepEqual(parsed.requires, [
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  ]);
});

test('多主機是常態：threads 兩個網域、xpost 三個網域', () => {
  assert.deepEqual(
    parse('threads-helper').targets.map((target) => target.host),
    ['www.threads.com', 'www.threads.net'],
  );

  assert.deepEqual(
    parse('xpost-card').targets.map((target) => target.host),
    ['x.com', 'twitter.com', 'www.threads.com'],
  );
});

test('四支都配 www.instagram.com → 同一個站台會掛多支腳本', () => {
  const onInstagram = ALL.filter((name) =>
    parse(name).targets.some((target) => target.host === 'www.instagram.com'),
  );

  assert.deepEqual(onInstagram, ['ig-comment-scraper', 'ig-dm-sender', 'ig-helper', 'peekly']);
});

test('沒有任何一支用萬用子網域（needs-host 照做但不用過度設計）', () => {
  for (const name of ALL) {
    for (const target of parse(name).targets) {
      assert.notEqual(target.proxyable, 'needs-host', `${name} → ${target.pattern}`);
    }
  }
});

test('⭐ revid-subs 的 *://*/* 不能代理，但一定要能投遞', () => {
  const parsed = parse('revid-subs');
  const [target] = parsed.targets;

  assert.equal(target.proxyable, 'rejected');
  assert.equal(target.deliverable, true, '投遞模式對任何腳本都成立');
  assert.ok(target.reason.length > 0);
  assert.ok(
    /具體主機|全世界/.test(target.reason),
    `拒絕訊息要說得像人話：${target.reason}`,
  );
});

test('⭐ 除了 revid-subs，其他六支都代理得起來', () => {
  for (const name of ALL.filter((candidate) => candidate !== 'revid-subs')) {
    const parsed = parse(name);
    assert.ok(parsed.targets.length > 0, `${name} 沒有 target`);
    assert.ok(
      parsed.targets.every((target) => target.proxyable === 'ready'),
      `${name} 有不能代理的 target`,
    );
  }
});

test('每一個 target 都同時帶 proxyable 與 deliverable', () => {
  for (const name of ALL) {
    for (const target of parse(name).targets) {
      assert.ok(['ready', 'needs-host', 'rejected'].includes(target.proxyable), name);
      assert.equal(target.deliverable, true, name);
    }
  }
});

test('路徑轉換：所有 /* 都變成 match-all 特例 *', () => {
  for (const name of ALL) {
    for (const target of parse(name).targets) {
      if (target.proxyable === 'rejected') continue;
      assert.equal(target.pathGlob, '*', `${name} → ${target.pattern}`);
    }
  }
});

test('metadata 可以安全地 JSON 來回（要存進 DB）', () => {
  for (const name of ALL) {
    const parsed = parse(name);
    const roundTripped = JSON.parse(JSON.stringify(parsed));

    assert.equal(roundTripped.name, parsed.name, name);
    assert.equal(roundTripped.targets.length, parsed.targets.length, name);
  }
});
