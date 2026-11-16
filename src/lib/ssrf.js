'use strict';

/**
 * SSRF 防護。「代理任意網址」是這個產品的本質，所以不能全擋，
 * 但內網、loopback、雲端 metadata 一律不准 —— 否則這支服務就是打家裡其他服務的跳板。
 *
 * 建立網站時檢查一次，每次代理請求再檢查一次（擋 DNS rebinding）。
 */

const dns = require('node:dns').promises;

const { isBlockedAddress } = require('./ip.js');

const BLOCKED_HOSTNAMES = Object.freeze(['metadata.google.internal', 'metadata.goog']);

class SsrfBlockedError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
  }
}

function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseOrigin(origin) {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

async function resolveAddresses(hostname, lookup) {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    const addresses = (Array.isArray(records) ? records : [records])
      .map((record) => (typeof record === 'string' ? record : record?.address))
      .filter((address) => typeof address === 'string');

    if (addresses.length === 0) {
      throw new SsrfBlockedError('dns_error', `${hostname} 沒有解析到任何 IP`);
    }
    return addresses;
  } catch (cause) {
    if (cause instanceof SsrfBlockedError) throw cause;
    throw new SsrfBlockedError('dns_error', `無法解析 ${hostname}：${cause.message}`);
  }
}

/**
 * @param {string} origin 例如 https://www.example.com
 * @param {{ allowPrivate?: boolean, lookup?: Function }} [options]
 * @returns {Promise<{ host: string, addresses: string[] }>}
 * @throws {SsrfBlockedError}
 */
async function assertOriginAllowed(origin, options = {}) {
  const { allowPrivate = false, lookup = dns.lookup } = options;

  const url = typeof origin === 'string' ? parseOrigin(origin) : null;
  if (!url) {
    throw new SsrfBlockedError('bad_origin', `不是合法的 origin：${String(origin)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('bad_scheme', `只接受 http/https，收到 ${url.protocol}`);
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(host)) {
    throw new SsrfBlockedError('blocked_hostname', `${host} 是被封鎖的主機名（雲端 metadata）`);
  }

  const addresses = await resolveAddresses(host, lookup);
  if (allowPrivate) return { host, addresses };

  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) {
    throw new SsrfBlockedError(
      'private_address',
      `${host} 解析到內部位址 ${blocked}；要代理內網請設 LOCALMONKEY_ALLOW_PRIVATE=1`,
    );
  }

  return { host, addresses };
}

module.exports = { assertOriginAllowed, isBlockedAddress, SsrfBlockedError, BLOCKED_HOSTNAMES };
