'use strict';

/**
 * IP 位址分類。只做「這個位址是不是內部網路」這一件事，fail closed：
 * 認不出來的字串一律當成封鎖，寧可少代理一個網站，也不要被當成打內網的跳板。
 */

const net = require('node:net');

function parseIPv4(input) {
  const parts = input.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function embeddedIPv4ToGroups(text) {
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (!tail.includes('.')) return text;

  const octets = parseIPv4(tail);
  if (!octets) return text;

  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  return `${text.slice(0, lastColon + 1)}${high}:${low}`;
}

function expandGroups(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;

  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

function ipv6ToBytes(input) {
  const withoutZone = input.split('%')[0];
  const groups = expandGroups(embeddedIPv4ToGroups(withoutZone));
  if (!groups) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isBlockedIPv4(octets) {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local（含雲端 metadata）
  return false;
}

function isBlockedIPv6(bytes) {
  const isMappedIPv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMappedIPv4) return isBlockedIPv4(bytes.slice(12));

  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/**
 * @param {unknown} address
 * @returns {boolean} true = 不准連
 */
function isBlockedAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return true;

  const family = net.isIP(address);
  if (family === 4) {
    const octets = parseIPv4(address);
    return octets ? isBlockedIPv4(octets) : true;
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address);
    return bytes ? isBlockedIPv6(bytes) : true;
  }

  return true;
}

module.exports = { isBlockedAddress, ipv6ToBytes };
