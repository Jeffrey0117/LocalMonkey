'use strict';

/**
 * 後台列表「功能」欄的旗標。
 *
 * 純函式，吃的是 `metadata`（存檔時算好的解析結果快取）而不是 source ——
 * 列表一次要畫十幾支腳本，不能為了畫一排小圖示把每支 source 都讀出來重新解析。
 *
 * metadata 可能是壞掉的舊資料（`db/userscripts.js` 的 METADATA_FALLBACK），
 * 所以每一格都要有安全預設值：列表畫不出來比列表少一個圖示嚴重得多。
 */

function countOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {{ metadata?: object, deliveryToken?: string|null }} [input]
 * @returns {{
 *   requires: number, resources: number, grants: number,
 *   unsupportedGrants: string[], needsShim: boolean, delivery: boolean,
 * }}
 */
function scriptFeatures({ metadata, deliveryToken } = {}) {
  const meta = metadata !== null && typeof metadata === 'object' ? metadata : {};

  return {
    requires: countOf(meta.requires),
    resources: countOf(meta.resources),
    // canonicalGrants 是正規化過的（GM.setValue → GM_setValue），舊資料只有 grants
    grants: countOf(meta.canonicalGrants ?? meta.grants),
    unsupportedGrants: stringsOf(meta.unsupportedGrants),
    needsShim: meta.needsShim === true,
    delivery: typeof deliveryToken === 'string' && deliveryToken.length > 0,
  };
}

module.exports = { scriptFeatures };
