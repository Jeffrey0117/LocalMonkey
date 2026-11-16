'use strict';

/**
 * 把一支 .user.js 原文解析成「後台與注入都看同一份」的結構。純函式。
 *
 * ⭐ userscript header 是唯一真相來源：名稱、配對、時機、權限全部從這裡來，
 *    後台的資訊列只是把這份結果畫出來（唯讀）。
 */

const { parseMetadataBlock, single, values } = require('./metadata.js');
const { classifyMatch, classifyExclude } = require('./match.js');
const { canonicalGrant, isSupportedGrant } = require('./grants.js');

const DEFAULT_NAME = '未命名腳本';
const DEFAULT_RUN_AT = 'document-end';
const RUN_AT_VALUES = new Set(['document-start', 'document-end', 'document-idle']);

function notice(level, message) {
  return Object.freeze({ level, message });
}

function trimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanList(raw, key) {
  return values(raw, key)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function dedupe(list) {
  return [...new Set(list)];
}

function resolveName(raw, fallbackName) {
  return trimmedOrNull(single(raw, 'name')) ?? trimmedOrNull(fallbackName) ?? DEFAULT_NAME;
}

function resolveRunAt(raw, notices) {
  const declared = trimmedOrNull(single(raw, 'run-at'));
  if (declared === null) return DEFAULT_RUN_AT;

  const normalized = declared.toLowerCase();
  if (RUN_AT_VALUES.has(normalized)) return normalized;

  if (normalized === 'document-body') {
    notices.push(
      notice('warn', '@run-at document-body 在 LocalMonkey 對應到 document-end（頁面結尾注入）'),
    );
    return DEFAULT_RUN_AT;
  }

  notices.push(notice('warn', `不認識的 @run-at「${declared}」，改用預設 ${DEFAULT_RUN_AT}`));
  return DEFAULT_RUN_AT;
}

function resolveGrants(raw, notices) {
  const declared = cleanList(raw, 'grant');
  const grantNone = declared.some((grant) => grant.toLowerCase() === 'none');
  const grants = grantNone ? [] : dedupe(declared);

  const supportedGrants = grants.filter((grant) => isSupportedGrant(grant));
  const unsupportedGrants = grants.filter((grant) => !isSupportedGrant(grant));

  if (unsupportedGrants.length > 0) {
    notices.push(
      notice('error', `LocalMonkey 尚未支援 ${unsupportedGrants.join('、')}，呼叫時會在 console 報錯`),
    );
  }

  return {
    grants,
    grantNone,
    supportedGrants,
    unsupportedGrants,
    canonicalGrants: dedupe(supportedGrants.map((grant) => canonicalGrant(grant))),
    needsShim: grants.length > 0,
  };
}

function resolveConnect(raw, notices) {
  const declared = cleanList(raw, 'connect').map((host) => host.toLowerCase());
  const connectAll = declared.includes('*');

  if (connectAll) {
    notices.push(
      notice(
        'error',
        '@connect * 不被接受：請列出具體主機，否則 GM_xmlhttpRequest 的請求會被擋下來',
      ),
    );
  }

  return { connect: dedupe(declared.filter((host) => host !== '*')), connectAll };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveRequires(raw, notices) {
  const declared = dedupe(cleanList(raw, 'require'));

  return declared.filter((url) => {
    if (isHttpUrl(url)) return true;
    notices.push(notice('warn', `@require「${url}」不是 http(s) 網址，已忽略`));
    return false;
  });
}

function resolveResources(raw, notices) {
  return cleanList(raw, 'resource').flatMap((entry) => {
    const [name, ...rest] = entry.split(/\s+/);
    const url = rest.join(' ').trim();

    if (name.length === 0 || url.length === 0) {
      notices.push(notice('warn', `@resource「${entry}」格式應該是「名稱 網址」，已忽略`));
      return [];
    }
    if (!isHttpUrl(url)) {
      notices.push(notice('warn', `@resource「${name}」的網址不是 http(s)，已忽略`));
      return [];
    }

    return [Object.freeze({ name, url })];
  });
}

function resolveTargets(raw, notices) {
  const matches = values(raw, 'match').map((pattern) => classifyMatch(pattern, { kind: 'match' }));
  const includes = values(raw, 'include').map((pattern) =>
    classifyMatch(pattern, { kind: 'include' }),
  );

  const seen = new Set();
  const targets = [...matches, ...includes].filter((target) => {
    const key = `${target.kind}|${target.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (targets.length > 0 && targets.every((target) => target.proxyable === 'rejected')) {
    notices.push(
      notice('error', '所有 @match / @include 都無法轉成代理網站，請改寫成具體主機（見每一列的原因）'),
    );
  }

  return targets;
}

function resolveExcludes(raw, notices) {
  const declared = [...cleanList(raw, 'exclude'), ...cleanList(raw, 'exclude_match')];

  return declared.map((pattern) => classifyExclude(pattern)).filter((exclude) => {
    if (exclude.ok) return true;
    notices.push(notice('warn', `@exclude「${exclude.pattern}」解析失敗：${exclude.reason}`));
    return false;
  });
}

/**
 * @param {string} source .user.js 全文
 * @param {{ fallbackName?: string }} [options]
 */
function parseUserscript(source, options = {}) {
  const { hasBlock, raw } = parseMetadataBlock(source);
  const notices = [];

  if (!hasBlock) {
    notices.push(
      notice('warn', '沒有偵測到 UserScript header，這支會被當成純 JS 片段，你得自己指定網域'),
    );
  }

  const runAt = resolveRunAt(raw, notices);
  const grantInfo = resolveGrants(raw, notices);
  const connectInfo = resolveConnect(raw, notices);
  const requires = resolveRequires(raw, notices);
  const resources = resolveResources(raw, notices);
  const targets = resolveTargets(raw, notices);
  const excludes = resolveExcludes(raw, notices);

  if (hasBlock && targets.length === 0) {
    notices.push(notice('warn', '沒有 @match / @include，LocalMonkey 不知道要把它掛在哪個網站'));
  }

  return Object.freeze({
    hasMetadataBlock: hasBlock,
    name: resolveName(raw, options.fallbackName),
    version: trimmedOrNull(single(raw, 'version')),
    description: trimmedOrNull(single(raw, 'description')),
    author: trimmedOrNull(single(raw, 'author')),
    namespace: trimmedOrNull(single(raw, 'namespace')),
    icon: trimmedOrNull(single(raw, 'icon')) ?? trimmedOrNull(single(raw, 'iconurl')),

    // 投遞模式會把這兩個換成 LocalMonkey 自己的端點（見 SPEC-console §8），
    // 但解析階段要先原樣留著 —— 使用者得看得到腳本原本指向哪裡。
    updateUrl: trimmedOrNull(single(raw, 'updateurl')),
    downloadUrl: trimmedOrNull(single(raw, 'downloadurl')),

    runAt,
    grants: Object.freeze(grantInfo.grants),
    grantNone: grantInfo.grantNone,
    supportedGrants: Object.freeze(grantInfo.supportedGrants),
    unsupportedGrants: Object.freeze(grantInfo.unsupportedGrants),
    canonicalGrants: Object.freeze(grantInfo.canonicalGrants),
    needsShim: grantInfo.needsShim,
    connect: Object.freeze(connectInfo.connect),
    connectAll: connectInfo.connectAll,
    requires: Object.freeze(requires),
    resources: Object.freeze(resources),
    noframes: values(raw, 'noframes').length > 0,
    targets: Object.freeze(targets),
    excludes: Object.freeze(excludes),
    notices: Object.freeze(notices.map((entry) => entry)),
  });
}

module.exports = { parseUserscript, DEFAULT_NAME, DEFAULT_RUN_AT };
