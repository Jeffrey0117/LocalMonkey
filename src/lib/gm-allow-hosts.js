'use strict';

/**
 * `GM_xmlhttpRequest` 的內網目標白名單（`LOCALMONKEY_GM_ALLOW_HOSTS`）。純函式。
 *
 * ## 為什麼需要它
 *
 * 真實的腳本會打自己機器上的後端：ig-helper / threads-helper / xpost-card 都宣告
 * `@connect localhost`，實際目標是 `http://localhost:8001`（AutoReel 的後端）。
 * SSRF 防護會把這些擋掉 —— 而且是最難除錯的那種失敗（腳本看起來有跑、請求靜默失敗）。
 *
 * ## 為什麼不用 LOCALMONKEY_ALLOW_PRIVATE
 *
 * 那個開關是給「代理目標」用的，打開等於連「代理任意私網站台」都放行，範圍太大。
 * 這份白名單只影響 `/__lm/gm/xhr`，而且是精確比對、預設空的。
 *
 * ## 規則
 *
 * - 比對 `url.host`（**含 port**）：`localhost` 不等於 `localhost:8001`
 * - 不做萬用字元、不做子網域推論 —— 要放行什麼就寫什麼
 * - 命中只是「豁免 SSRF 的私網檢查」，**`@connect` 宣告還是要過**（兩道都要過）
 */

const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * `"localhost:8001, 127.0.0.1:8001"` → `['localhost:8001', '127.0.0.1:8001']`
 * @param {string|undefined} raw
 * @returns {readonly string[]}
 */
function parseAllowHosts(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return Object.freeze([]);

  const entries = raw
    .split(',')
    .map((entry) => normalize(entry))
    .filter((entry) => entry.length > 0);

  return Object.freeze([...new Set(entries)]);
}

/**
 * 這個目標網址在不在白名單裡（精確比對 host:port）。
 * @param {readonly string[]} allowHosts
 * @param {URL} url
 */
function isAllowedHost(allowHosts, url) {
  if (!Array.isArray(allowHosts) || allowHosts.length === 0) return false;
  if (!(url instanceof URL)) return false;

  return allowHosts.includes(normalize(url.host));
}

/**
 * 這個主機名看起來是不是「一定會被 SSRF 擋掉」的本機位址。
 *
 * 只認字面上的 loopback —— UI 不能做 DNS 查詢，所以寧可只認得出最常見的那幾個，
 * 也不要猜（猜錯會變成假警告，使用者就不信警告了）。
 * @param {string} host 可能帶 port
 */
function looksLoopback(host) {
  const normalized = normalize(host);
  const hostname = normalized.split(':')[0];

  if (LOOPBACK_HOSTNAMES.includes(normalized)) return true;
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return true;
  if (hostname.startsWith('127.')) return true;
  if (hostname.endsWith('.localhost')) return true;

  return false;
}

/**
 * 某個 `@connect` 宣告的主機，有沒有被白名單涵蓋到？
 *
 * `@connect` 不帶 port（真實樣本就是裸的 `localhost`），而白名單一定帶 port，
 * 所以這裡比對的是「白名單裡有沒有哪一筆的 hostname 等於這個宣告」。
 * 這是給 UI 與存檔警告用的提示，不是授權判斷 —— 真正的授權是 isAllowedHost。
 * @param {readonly string[]} allowHosts
 * @param {string} connectHost
 */
function isConnectHostCovered(allowHosts, connectHost) {
  const declared = normalize(connectHost).split(':')[0];
  if (declared.length === 0) return false;

  return (Array.isArray(allowHosts) ? allowHosts : []).some(
    (entry) => normalize(entry).split(':')[0] === declared,
  );
}

/**
 * 這支腳本有哪些 `@connect` 主機會被 SSRF 擋掉（因為是本機位址又沒進白名單）。
 * @param {readonly string[]} connect 腳本宣告的 @connect 清單
 * @param {readonly string[]} allowHosts
 * @returns {string[]}
 */
function blockedConnectHosts(connect, allowHosts) {
  return (Array.isArray(connect) ? connect : [])
    .filter((host) => looksLoopback(host))
    .filter((host) => !isConnectHostCovered(allowHosts, host));
}

module.exports = {
  parseAllowHosts,
  isAllowedHost,
  looksLoopback,
  isConnectHostCovered,
  blockedConnectHosts,
  LOOPBACK_HOSTNAMES,
};
