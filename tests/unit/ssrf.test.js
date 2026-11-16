'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedAddress, assertOriginAllowed, SsrfBlockedError } = require('../../src/lib/ssrf.js');

const BLOCKED = [
  '127.0.0.1',
  '127.1.2.3',
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  '::',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
];

const ALLOWED = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '11.0.0.1',
  '172.15.0.1',
  '172.32.0.1',
  '192.167.1.1',
  '2606:4700:4700::1111',
];

test('私網 / loopback / link-local 位址被判定為封鎖', () => {
  for (const ip of BLOCKED) {
    assert.equal(isBlockedAddress(ip), true, `${ip} 應該被封鎖`);
  }
});

test('公開位址不被封鎖', () => {
  for (const ip of ALLOWED) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 不該被封鎖`);
  }
});

test('不認得的字串 fail closed（當成封鎖）', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress(undefined), true);
});

function fakeLookup(map) {
  return async (hostname) => {
    if (!(hostname in map)) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return map[hostname].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

test('公開網域通過，回傳解析到的位址', async () => {
  const result = await assertOriginAllowed('https://example.com', {
    lookup: fakeLookup({ 'example.com': ['93.184.216.34'] }),
  });
  assert.equal(result.host, 'example.com');
  assert.deepEqual(result.addresses, ['93.184.216.34']);
});

test('解析到私網 → 丟 SsrfBlockedError', async () => {
  await assert.rejects(
    () =>
      assertOriginAllowed('http://sneaky.test', {
        lookup: fakeLookup({ 'sneaky.test': ['192.168.0.11'] }),
      }),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError);
      assert.equal(err.reason, 'private_address');
      assert.ok(err.message.includes('192.168.0.11'));
      return true;
    },
  );
});

test('多筆 A 記錄只要有一筆是私網就拒絕（DNS rebinding 混搭）', async () => {
  await assert.rejects(
    () =>
      assertOriginAllowed('http://mixed.test', {
        lookup: fakeLookup({ 'mixed.test': ['93.184.216.34', '127.0.0.1'] }),
      }),
    SsrfBlockedError,
  );
});

test('allowPrivate 時放行私網（代理自己的 dev server 用）', async () => {
  const result = await assertOriginAllowed('http://127.0.0.1:3000', {
    allowPrivate: true,
    lookup: fakeLookup({ '127.0.0.1': ['127.0.0.1'] }),
  });
  assert.deepEqual(result.addresses, ['127.0.0.1']);
});

test('非 http(s) scheme 一律拒絕，即使 allowPrivate', async () => {
  for (const origin of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x.test']) {
    await assert.rejects(
      () => assertOriginAllowed(origin, { allowPrivate: true, lookup: fakeLookup({}) }),
      (err) => {
        assert.equal(err.reason, 'bad_scheme');
        return true;
      },
    );
  }
});

test('壞掉的 origin 字串 → bad_origin', async () => {
  await assert.rejects(
    () => assertOriginAllowed('not a url', { lookup: fakeLookup({}) }),
    (err) => {
      assert.equal(err.reason, 'bad_origin');
      return true;
    },
  );
});

test('metadata.google.internal 直接封鎖，不用等 DNS', async () => {
  await assert.rejects(
    () =>
      assertOriginAllowed('http://METADATA.google.internal', {
        lookup: async () => {
          throw new Error('不該呼叫 DNS');
        },
      }),
    (err) => {
      assert.equal(err.reason, 'blocked_hostname');
      return true;
    },
  );
});

test('allowPrivate 也不放行 metadata 主機名', async () => {
  await assert.rejects(
    () => assertOriginAllowed('http://metadata.google.internal', { allowPrivate: true }),
    (err) => {
      assert.equal(err.reason, 'blocked_hostname');
      return true;
    },
  );
});

test('DNS 解析失敗 → dns_error，不是靜默放行', async () => {
  await assert.rejects(
    () => assertOriginAllowed('http://nope.invalid', { lookup: fakeLookup({}) }),
    (err) => {
      assert.equal(err.reason, 'dns_error');
      return true;
    },
  );
});

test('預設用真的 dns.lookup：IP 字面值不需要網路也擋得住', async () => {
  await assert.rejects(() => assertOriginAllowed('http://127.0.0.1:8080'), SsrfBlockedError);
});
