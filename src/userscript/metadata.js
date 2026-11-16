'use strict';

/**
 * UserScript metadata block 解析。純函式：吃字串吐物件，不碰 DB、不碰網路。
 *
 * 這一層只負責「把 `// @key value` 撿出來」，不解釋任何 key 的語意
 * （那是 match.js / parse.js 的事）。
 */

/** 第一個 `// ==UserScript==` … `// ==/UserScript==` 區塊。沒有結束標記就不算。 */
const BLOCK_PATTERN = /\/\/[ \t]*==UserScript==[ \t]*\r?\n([\s\S]*?)\/\/[ \t]*==\/UserScript==/;

/** `// @key value`：`//` 後面的空白可有可無，key 後面用空白或 tab 分隔 */
const ENTRY_PATTERN = /^[ \t]*\/\/[ \t]*@([A-Za-z0-9_:.-]+)[ \t]*(.*)$/;

const EMPTY_RAW = Object.freeze({});
const EMPTY_VALUES = Object.freeze([]);

function collectEntries(blockBody) {
  return blockBody.split(/\r?\n/).reduce((acc, line) => {
    const matched = ENTRY_PATTERN.exec(line);
    if (!matched) return acc;

    const key = matched[1].toLowerCase();
    const value = matched[2].trim();

    return { ...acc, [key]: [...(acc[key] ?? []), value] };
  }, {});
}

function freezeRaw(raw) {
  return Object.freeze(
    Object.fromEntries(Object.entries(raw).map(([key, list]) => [key, Object.freeze(list)])),
  );
}

/**
 * @param {string} source 整支 .user.js 原文
 * @returns {{ hasBlock: boolean, raw: Readonly<Record<string, readonly string[]>> }}
 */
function parseMetadataBlock(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { hasBlock: false, raw: EMPTY_RAW };
  }

  const matched = BLOCK_PATTERN.exec(source);
  if (!matched) return { hasBlock: false, raw: EMPTY_RAW };

  return { hasBlock: true, raw: freezeRaw(collectEntries(matched[1])) };
}

/**
 * 某個 key 的所有值（宣告順序）。
 * @returns {readonly string[]}
 */
function values(raw, key) {
  return raw?.[key] ?? EMPTY_VALUES;
}

/**
 * 某個 key 的第一個值。`@name` 這類有 locale 變體（`@name:zh-TW`）的 key，
 * 優先拿「沒有 locale 的那個」；真的只有變體時才退回第一個變體。
 * @returns {string|null}
 */
function single(raw, key) {
  const direct = values(raw, key);
  if (direct.length > 0) return direct[0];

  if (key.includes(':')) return null;

  const localized = Object.keys(raw ?? {}).find((candidate) => candidate.startsWith(`${key}:`));
  return localized ? raw[localized][0] : null;
}

module.exports = { parseMetadataBlock, single, values, BLOCK_PATTERN };
