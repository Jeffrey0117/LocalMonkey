'use strict';

const crypto = require('node:crypto');

/**
 * @param {string} prefix 例如 'scr'
 * @returns {string} 例如 scr_3f2a91c4d5e60718
 */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { newId, nowIso };
