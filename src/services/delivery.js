'use strict';

/**
 * 投遞模式：把腳本餵給 Tampermonkey（SPEC-console §8）。純函式 + 一個隨機 token 產生器。
 *
 * 代理模式改的是「送到瀏覽器的那份 HTML」；投遞模式則是讓 Tampermonkey 自己裝這支腳本，
 * 所以 GM_* 全部原生可用、不碰登入站的風控、連「配全世界」的 pattern 都能用。
 */

const crypto = require('node:crypto');

const { BLOCK_PATTERN, single, parseMetadataBlock } = require('../userscript/metadata.js');

const TOKEN_BYTES = 32;
const DEFAULT_SLUG = 'userscript';
const MAX_SLUG_LENGTH = 48;
const INITIAL_VERSION = '1.0.0';

/** 每支腳本一組不可猜的路徑 token（端點免認證，靠它當憑證） */
function newDeliveryToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * 給人看的檔名。只影響 Tampermonkey 顯示，不參與驗證 ——
 * 但還是要限字集，不然 `@name` 裡的斜線就跑出路徑了。
 */
function slugForScriptName(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');

  return slug.length > 0 ? slug : DEFAULT_SLUG;
}

function dominantEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 在 metadata block 裡替換（或補上）一個 key。
 * 只動 block 內，而且保留原本的行尾 —— 真實腳本全是 CRLF，混進裸 \n 會很醜。
 */
function replaceOrInsert(block, key, value, eol) {
  const linePattern = new RegExp(`^([ \\t]*//[ \\t]*@${key})([ \\t]+[^\\r\\n]*)?$`, 'gim');

  if (linePattern.test(block)) {
    return block.replace(linePattern, (full, lead) => `${lead}  ${value}`);
  }

  // 沒有這個 key：插在結束標記之前
  return block.replace(
    /^([ \t]*\/\/[ \t]*==\/UserScript==[ \t]*)$/im,
    `// @${key}  ${value}${eol}$1`,
  );
}

/**
 * 把 `@updateURL` / `@downloadURL` 換成本端點的絕對網址。
 *
 * ⛔ 少了這段整個功能沒意義：Tampermonkey 會繼續去腳本原本寫的地方
 * （真實樣本是 `http://localhost:8001/scripts/...`）檢查更新。
 *
 * 只動投遞出去的那一份，**不要寫回資料庫**。
 */
function rewriteHeaderUrls(source, deliveryUrl) {
  if (typeof source !== 'string' || typeof deliveryUrl !== 'string') return source;

  const matched = BLOCK_PATTERN.exec(source);
  if (!matched) return source; // 沒有 header 就沒有安裝清單可以改

  const block = matched[0];
  const eol = dominantEol(block);

  const rewritten = ['updateURL', 'downloadURL'].reduce(
    (current, key) => replaceOrInsert(current, key, deliveryUrl, eol),
    block,
  );

  return source.slice(0, matched.index) + rewritten + source.slice(matched.index + block.length);
}

/** @returns {string|null} */
function versionOf(source) {
  const { raw } = parseMetadataBlock(source);
  const value = single(raw, 'version');

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function segmentsOf(version) {
  return String(version).split('.');
}

/**
 * 版本比較。照「數字段」比，不是字串比 —— `1.2.10` 必須大於 `1.2.9`。
 * @returns {-1|0|1}
 */
function compareVersions(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;

  const a = segmentsOf(left);
  const b = segmentsOf(right);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = a[index] ?? '0';
    const rightPart = b[index] ?? '0';

    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }

    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

/**
 * 把最後一段數字 +1。沒有 `@version` 就補 `1.0.0`，結尾沒有數字就接上 `.1`
 * （不要把使用者寫的東西丟掉）。
 */
function bumpVersion(source) {
  if (typeof source !== 'string') return source;

  const matched = BLOCK_PATTERN.exec(source);
  if (!matched) return source;

  const block = matched[0];
  const eol = dominantEol(block);
  const current = versionOf(source);

  const next =
    current === null
      ? INITIAL_VERSION
      : /\d+$/.test(current)
        ? current.replace(/\d+$/, (digits) => String(Number(digits) + 1))
        : `${current}.1`;

  const rewritten = replaceOrInsert(block, 'version', next, eol);

  return source.slice(0, matched.index) + rewritten + source.slice(matched.index + block.length);
}

/**
 * 版本有沒有往上走？沒有的話 Tampermonkey 不會更新到這一版 ——
 * 這是「看起來存好了其實所有裝置原地不動」的唯一原因，所以要明確回報。
 */
function isVersionBumped(previousVersion, nextVersion) {
  if (nextVersion === null || nextVersion === undefined) return false;
  if (previousVersion === null || previousVersion === undefined) return true;

  return compareVersions(nextVersion, previousVersion) > 0;
}

/**
 * Host header 是請求端控制的，所以限字集 —— 不要讓奇怪的值跑進我們產生的網址。
 * （Node 的 HTTP parser 已經擋掉換行，這裡再擋一次其他的。）
 */
const HOST_PATTERN = /^[A-Za-z0-9.\-:[\]]+$/;

/**
 * 從請求本身推出 origin。
 *
 * ⛔ 刻意不從設定檔讀：使用者會從 `127.0.0.1`、區網 IP、或 tunnel 網域來裝，
 * 每一種都要給對應的網址。（踩過的坑：後端自己組對外網址，在代理後面會組出內部位址。）
 * @returns {string|null}
 */
function requestOrigin(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null;

  const forwarded = req.headers['x-forwarded-proto'];
  const protocol =
    typeof forwarded === 'string' && forwarded.length > 0
      ? forwarded.split(',')[0].trim()
      : req.protocol || 'http';

  return /^https?$/.test(protocol) ? `${protocol}://${host}` : `http://${host}`;
}

/**
 * 這支腳本的安裝網址。
 * @returns {string|null} 認不出 Host 時回 null（呼叫端就不要改寫 header）
 */
function buildDeliveryUrl(req, script) {
  const origin = requestOrigin(req);
  if (origin === null || typeof script?.delivery_token !== 'string') return null;

  return `${origin}/s/${script.delivery_token}/${slugForScriptName(script.name)}.user.js`;
}

module.exports = {
  newDeliveryToken,
  slugForScriptName,
  requestOrigin,
  buildDeliveryUrl,
  rewriteHeaderUrls,
  versionOf,
  bumpVersion,
  compareVersions,
  isVersionBumped,
  INITIAL_VERSION,
};
