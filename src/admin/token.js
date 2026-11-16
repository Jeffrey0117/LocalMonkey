'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_FILENAME = 'admin-token.txt';

function readTokenFile(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`讀不到 admin token 檔案 ${file}：${error.message}`);
  }
}

function writeTokenFile(file, token) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    throw new Error(`寫不進 admin token 檔案 ${file}：${error.message}`);
  }
}

/**
 * 決定後台 token。順序：env → data/admin-token.txt → 現場產生一把。
 * 沒有任何 hardcoded 預設值，也沒有「沒設就不驗證」這種模式。
 *
 * @returns {{ token: string, source: 'env'|'file'|'generated', file: string }}
 */
function ensureAdminToken({ envToken, dataDir, logger }) {
  const file = path.join(dataDir, TOKEN_FILENAME);

  if (typeof envToken === 'string' && envToken.trim().length > 0) {
    return { token: envToken.trim(), source: 'env', file };
  }

  const existing = readTokenFile(file);
  if (existing) return { token: existing, source: 'file', file };

  const token = crypto.randomBytes(32).toString('hex');
  writeTokenFile(file, token);
  logger.info(`已產生新的後台 token（也存在 ${file}）：${token}`);

  return { token, source: 'generated', file };
}

module.exports = { ensureAdminToken, TOKEN_FILENAME };
