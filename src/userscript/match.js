'use strict';

/**
 * `@match` / `@include` / `@exclude` → （主機, 路徑 glob）。純函式。
 *
 * ⛔ 這個檔案存在的唯一理由，是 Chrome match pattern 與 LocalMonkey glob 的
 * 語意不一樣，照抄會無聲出錯：
 *
 *   match pattern 的 `*`：**會**跨 `/`（`/items/*` 配得到 `/items/42/detail`）
 *   LocalMonkey 的 `*`  ：**不**跨 `/`（要 `**` 才跨，見 lib/glob.js）
 *
 * 所以路徑裡的每一段 `*` 都要翻成 `**`，而整站的 `/*` 翻成 glob 的 match-all 特例 `*`。
 *
 * 每個 target 有**兩個互相獨立的軸**（SPEC-console §8）：
 *
 *   proxyable   能不能用代理模式（ready / needs-host / rejected）
 *   deliverable 能不能用投遞模式 —— **永遠 true**，任何腳本都能讓 Tampermonkey 裝
 *
 * 「配全世界」那種 pattern（all_urls、scheme 與主機都是萬用）會是
 * `proxyable: 'rejected'` 但 `deliverable: true`：反向代理必須指向具體主機，
 * 但同一支腳本投遞給 Tampermonkey 就完全正常。
 * UI 不要說「這支不支援」，要說「不能用代理模式（原因…），可以用投遞模式」。
 *
 * （註：這段刻意不寫出那個 pattern 的字面值 —— 它含有 `*` 加斜線，
 *   會把這個區塊註解提前關掉。踩過一次了。）
 */

const { MAX_PATTERN_LENGTH } = require('../lib/glob.js');

const SCHEME_PATTERN = /^(\*|[A-Za-z][A-Za-z0-9+.-]*):\/\//;
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/;
const REGEX_FORM_PATTERN = /^\/.*\/[gimsuy]*$/;
const REGEX_SCHEME_PATTERN = /^(https|http):(?:\\\/|\/){2}/i;

const REASONS = Object.freeze({
  notString: 'pattern 是空的或不是字串',
  allUrls: '反向代理必須指向具體主機，配全世界沒有意義',
  noScheme: '@match 必須寫成 <scheme>://<host><path>',
  badScheme: (scheme) => `只支援 http / https / *（收到 ${scheme}）`,
  emptyHost: '看不出主機名',
  badHost: (host) => `「${host}」不是合法的主機名`,
  wildcardInHost: '主機名裡有萬用字元，無法推斷要代理哪一台，請改寫成具體主機',
  tooLong: `路徑太長：轉換出來的 glob 超過 ${MAX_PATTERN_LENGTH} 個字`,
  regexNoHost: '正則形式的 @include 裡抽不出字面主機，請改用 @match 指定具體網域',
  regexNotSupported: '正則形式不支援（請用 <scheme>://<host><path>）',
});

const WILDCARD_SUBDOMAIN_REASON =
  '萬用子網域：預設提議這個主機，可以到「網站」分頁補上具體的子網域';
const REGEX_WIDENED_WARNING =
  '正則 @include 的路徑條件無法轉換，已放寬成整站（請確認這是你要的範圍）';

function rejected(pattern, kind, reason) {
  return freezeTarget({
    pattern,
    kind,
    proxyable: 'rejected',
    deliverable: true,
    scheme: null,
    host: null,
    wildcardHost: false,
    insecure: false,
    pathGlob: null,
    targetOrigin: null,
    reason,
    warning: null,
  });
}

function freezeTarget(target) {
  return Object.freeze(target);
}

/**
 * match pattern 的路徑 → LocalMonkey glob。
 * @param {string} path 例如 `/items/*`
 * @returns {string}
 */
function matchPathToGlob(path) {
  const raw = typeof path === 'string' ? path : '';
  const withoutQuery = raw.split(/[?#]/)[0];

  if (withoutQuery.length === 0) return '*';

  const normalized = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  if (normalized === '/*') return '*'; // glob 的 match-all 特例
  if (normalized === '/') return '/'; // 只有首頁

  return normalized.replace(/\*+/g, '**');
}

function splitScheme(trimmed, kind) {
  const matched = SCHEME_PATTERN.exec(trimmed);
  if (!matched) {
    // @include 可以不寫 scheme（`example.com/*`）；@match 一定要寫
    return kind === 'include'
      ? { ok: true, scheme: 'https', rest: trimmed }
      : { ok: false, reason: REASONS.noScheme };
  }

  const token = matched[1].toLowerCase();
  const rest = trimmed.slice(matched[0].length);

  if (token === '*' || token === 'https') return { ok: true, scheme: 'https', rest };
  if (token === 'http') return { ok: true, scheme: 'http', rest };

  return { ok: false, reason: REASONS.badScheme(token) };
}

function splitHostAndPath(rest) {
  const slash = rest.indexOf('/');
  return slash === -1
    ? { host: rest.toLowerCase(), path: '' }
    : { host: rest.slice(0, slash).toLowerCase(), path: rest.slice(slash) };
}

/**
 * 主機樣式 → `ready` / `needs-host` / `rejected`（含萬用字元的細節）。
 * `allowAnyHost` 只給 @exclude 用：排除條件放寬不會變成開放代理。
 */
function classifyHost(host, { allowAnyHost = false } = {}) {
  if (host.length === 0) return { status: 'rejected', reason: REASONS.emptyHost };

  if (host === '*') {
    return allowAnyHost
      ? { status: 'any' }
      : { status: 'rejected', reason: REASONS.allUrls };
  }

  if (host.startsWith('*.')) {
    const domain = host.slice(2);
    if (domain.length === 0 || domain.includes('*') || !HOST_PATTERN.test(domain)) {
      return { status: 'rejected', reason: REASONS.wildcardInHost };
    }
    return { status: 'needs-host', host: domain, wildcardHost: true };
  }

  if (host.includes('*')) return { status: 'rejected', reason: REASONS.wildcardInHost };
  if (!HOST_PATTERN.test(host)) return { status: 'rejected', reason: REASONS.badHost(host) };

  return { status: 'ready', host, wildcardHost: false };
}

function isRegexForm(trimmed) {
  return trimmed.length >= 2 && REGEX_FORM_PATTERN.test(trimmed);
}

/**
 * 正則形式的 @include：只在「開頭就是字面 scheme + 字面主機」時才採用，
 * 其他一律拒絕 —— 規格明說不要猜。
 */
function extractHostFromRegex(trimmed) {
  const withoutDelimiters = trimmed.slice(1).replace(/\/[gimsuy]*$/, '');
  const body = withoutDelimiters.replace(/^\^/, '');

  const scheme = REGEX_SCHEME_PATTERN.exec(body);
  if (!scheme) return null;

  let host = '';
  let index = scheme[0].length;

  while (index < body.length) {
    const char = body[index];

    if (char === '\\') {
      const next = body[index + 1];
      if (next !== '.' && next !== '-') break; // \d / \w / \/ … → 主機名結束
      host += next;
      index += 2;
      continue;
    }

    if (/[a-z0-9-]/i.test(char)) {
      host += char;
      index += 1;
      continue;
    }

    break;
  }

  const rest = body.slice(index);
  const terminated = rest.length === 0 || rest === '$' || rest.startsWith('/') || rest.startsWith('\\/');

  if (!terminated || !HOST_PATTERN.test(host)) return null;

  return { host: host.toLowerCase(), scheme: scheme[1].toLowerCase() };
}

function buildTarget({ pattern, kind, scheme, hostResult, pathGlob, warning = null }) {
  if (pathGlob !== null && pathGlob.length > MAX_PATTERN_LENGTH) {
    return rejected(pattern, kind, REASONS.tooLong);
  }

  return freezeTarget({
    pattern,
    kind,
    proxyable: hostResult.status,
    deliverable: true,
    scheme,
    host: hostResult.host,
    wildcardHost: hostResult.wildcardHost === true,
    insecure: scheme === 'http',
    pathGlob,
    targetOrigin: `${scheme}://${hostResult.host}`,
    reason: hostResult.status === 'needs-host' ? WILDCARD_SUBDOMAIN_REASON : null,
    warning,
  });
}

/**
 * @param {string} pattern `@match` / `@include` 的值
 * @param {{ kind?: 'match'|'include' }} [options]
 */
function classifyMatch(pattern, options = {}) {
  const kind = options.kind === 'include' ? 'include' : 'match';

  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return rejected(pattern ?? null, kind, REASONS.notString);
  }

  const trimmed = pattern.trim();
  if (trimmed === '<all_urls>') return rejected(trimmed, kind, REASONS.allUrls);

  if (kind === 'include' && isRegexForm(trimmed)) {
    const extracted = extractHostFromRegex(trimmed);
    if (!extracted) return rejected(trimmed, kind, REASONS.regexNoHost);

    return buildTarget({
      pattern: trimmed,
      kind,
      scheme: extracted.scheme === 'http' ? 'http' : 'https',
      hostResult: { status: 'ready', host: extracted.host, wildcardHost: false },
      pathGlob: '*',
      warning: REGEX_WIDENED_WARNING,
    });
  }

  const scheme = splitScheme(trimmed, kind);
  if (!scheme.ok) return rejected(trimmed, kind, scheme.reason);

  const { host, path } = splitHostAndPath(scheme.rest);
  const hostResult = classifyHost(host);
  if (hostResult.status === 'rejected') return rejected(trimmed, kind, hostResult.reason);

  return buildTarget({
    pattern: trimmed,
    kind,
    scheme: scheme.scheme,
    hostResult,
    pathGlob: matchPathToGlob(path),
  });
}

/**
 * `@exclude` / `@exclude_match`。排除條件允許萬用主機（放寬不危險），
 * 但解析失敗時一定要回 ok:false —— 絕不能退化成「排除全部」。
 */
function classifyExclude(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return Object.freeze({ pattern: pattern ?? null, ok: false, reason: REASONS.notString });
  }

  const trimmed = pattern.trim();

  if (isRegexForm(trimmed)) {
    return Object.freeze({ pattern: trimmed, ok: false, reason: REASONS.regexNotSupported });
  }

  if (trimmed === '<all_urls>') {
    return Object.freeze({
      pattern: trimmed,
      ok: true,
      hostScope: Object.freeze({ kind: 'any' }),
      pathGlob: '*',
      reason: null,
    });
  }

  const scheme = splitScheme(trimmed, 'include');
  if (!scheme.ok) return Object.freeze({ pattern: trimmed, ok: false, reason: scheme.reason });

  const { host, path } = splitHostAndPath(scheme.rest);
  const hostResult = classifyHost(host, { allowAnyHost: true });
  if (hostResult.status === 'rejected') {
    return Object.freeze({ pattern: trimmed, ok: false, reason: hostResult.reason });
  }

  const hostScope =
    hostResult.status === 'any'
      ? { kind: 'any' }
      : hostResult.wildcardHost
        ? { kind: 'suffix', domain: hostResult.host }
        : { kind: 'host', host: hostResult.host };

  const pathGlob = matchPathToGlob(path);
  if (pathGlob.length > MAX_PATTERN_LENGTH) {
    return Object.freeze({ pattern: trimmed, ok: false, reason: REASONS.tooLong });
  }

  return Object.freeze({
    pattern: trimmed,
    ok: true,
    hostScope: Object.freeze(hostScope),
    pathGlob,
    reason: null,
  });
}

/**
 * 這條排除規則要不要套用在某個主機上。
 */
function excludeAppliesToHost(hostScope, host) {
  if (!hostScope || typeof host !== 'string') return false;

  const target = host.toLowerCase();

  if (hostScope.kind === 'any') return true;
  if (hostScope.kind === 'host') return hostScope.host === target;
  if (hostScope.kind === 'suffix') {
    return target === hostScope.domain || target.endsWith(`.${hostScope.domain}`);
  }

  return false;
}

module.exports = {
  classifyMatch,
  classifyExclude,
  excludeAppliesToHost,
  matchPathToGlob,
  REASONS,
};
