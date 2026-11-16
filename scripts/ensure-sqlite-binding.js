'use strict';

/**
 * npm 12 預設擋掉依賴的 install script（`allowScripts` 政策），
 * better-sqlite3 因此不會去下載 prebuilt binary，require 的時候才爆
 * 「Could not locate the bindings file」。
 *
 * 這支腳本在 install 之後補跑 prebuild-install。這台機器沒有 MSVC，
 * 所以「下載 prebuilt」是唯一的路：編譯不會成功。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
const BINDING = path.join(PACKAGE_DIR, 'build', 'Release', 'better_sqlite3.node');
const PREBUILD_INSTALL = path.join(__dirname, '..', 'node_modules', 'prebuild-install', 'bin.js');

function main() {
  if (!fs.existsSync(PACKAGE_DIR)) {
    return; // 還沒裝依賴，沒事可做
  }
  if (fs.existsSync(BINDING)) {
    return;
  }
  if (!fs.existsSync(PREBUILD_INSTALL)) {
    console.warn('[localmonkey] 找不到 prebuild-install，請手動處理 better-sqlite3 的 binding');
    return;
  }

  try {
    execFileSync(process.execPath, [PREBUILD_INSTALL], {
      cwd: PACKAGE_DIR,
      stdio: 'inherit',
      windowsHide: true,
    });
    console.log('[localmonkey] 已補上 better-sqlite3 的 prebuilt binding');
  } catch (error) {
    console.warn(
      '[localmonkey] 自動補 better-sqlite3 binding 失敗：' +
        `${error.message}\n` +
        '請手動執行：cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js',
    );
  }
}

main();
