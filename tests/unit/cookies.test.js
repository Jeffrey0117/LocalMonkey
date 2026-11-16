'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteSetCookie, parseCookieHeader } = require('../../src/lib/cookies.js');

test('拿掉 Domain=（不然瀏覽器會因為網域不符直接丟掉 cookie）', () => {
  const out = rewriteSetCookie('sid=abc; Domain=.example.com; Path=/; HttpOnly');
  assert.equal(/domain=/i.test(out), false);
  assert.ok(out.startsWith('sid=abc'));
  assert.ok(/Path=\//.test(out));
  assert.ok(/HttpOnly/.test(out));
});

test('拿掉 Secure（本機是 http，帶 Secure 的 cookie 不會被存下來）', () => {
  const out = rewriteSetCookie('sid=abc; Secure; HttpOnly');
  assert.equal(/\bsecure\b/i.test(out), false);
  assert.ok(/HttpOnly/.test(out));
});

test('SameSite 一律改成 Lax', () => {
  assert.ok(/SameSite=Lax/.test(rewriteSetCookie('a=1; SameSite=None')));
  assert.ok(/SameSite=Lax/.test(rewriteSetCookie('a=1; samesite=strict')));
  assert.ok(/SameSite=Lax/.test(rewriteSetCookie('a=1')), '原本沒有就補上');
  assert.equal(rewriteSetCookie('a=1; SameSite=None').match(/SameSite/gi).length, 1);
});

test('保留 Max-Age / Expires / Path / HttpOnly', () => {
  const out = rewriteSetCookie(
    'sid=v; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Path=/app; HttpOnly',
  );
  assert.ok(out.includes('Expires=Wed, 21 Oct 2026 07:28:00 GMT'));
  assert.ok(out.includes('Max-Age=3600'));
  assert.ok(out.includes('Path=/app'));
  assert.ok(out.includes('HttpOnly'));
});

test('cookie 值裡有 = 不會被切壞', () => {
  const out = rewriteSetCookie('token=a=b=c; Domain=x.test');
  assert.ok(out.startsWith('token=a=b=c'));
});

test('空字串 / 非字串回 null，呼叫端就知道要跳過', () => {
  assert.equal(rewriteSetCookie(''), null);
  assert.equal(rewriteSetCookie(undefined), null);
  assert.equal(rewriteSetCookie(123), null);
});

test('parseCookieHeader 取出單一 cookie', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader('lm_site=example'), { lm_site: 'example' });
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader(undefined), {});
});

test('parseCookieHeader 處理 URL 編碼與空白', () => {
  assert.deepEqual(parseCookieHeader('  a = %E4%B8%AD ; b=2 '), { a: '中', b: '2' });
});

test('parseCookieHeader 壞的編碼不會爆', () => {
  assert.deepEqual(parseCookieHeader('a=%E4%'), { a: '%E4%' });
});
