'use strict';

/**
 * 啟動時的一道檢查：**商家金鑰有沒有被寫進程式碼裡**（SPEC-checkout §0.1）。
 *
 * 規格的原話是「啟動時若偵測到金鑰疑似被寫進程式碼（硬編在 `src/` 下），
 * 要大聲警告」。這支刻意做得很窄：
 *
 * ⛔ **只比對「env 裡那個確切的值」在不在 `src/` 的檔案裡**，不做任何
 * 「這串看起來像金鑰」的猜測。理由是啟動時的警告只有在**零誤報**的時候
 * 才有人會理它 —— 一個每次啟動都在喊狼來了的檢查，等於把真正中招的那次
 * 也一起消音。而「值一模一樣」這個條件沒有誤報的空間。
 *
 * ⛔ 這個窄法剛好蓋住危險的那一半：金鑰被貼進 `src/` **而且**設在 env 裡
 * （＝正在被使用）就會被抓到。只貼進 `src/` 沒設 env 的話，服務根本就是
 * 示範模式，那把金鑰不會被任何一筆交易用到。
 *
 * ⛔ **警告訊息裡不准印出金鑰本身**（印了就等於把它寫進 log，而那正是這支
 * 在防的事）。只說「哪個環境變數的值」出現在「哪個檔案」。
 *
 * 讀整個 `src/` 一次的成本是幾十個小檔案，一輩子只在啟動時跑一次。
 */

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '..');

/** 只掃我們自己寫的那幾種檔案。`vendor/` 是原樣搬進來的第三方檔案。 */
const SCANNED_EXTENSIONS = Object.freeze(['.js', '.html', '.css', '.json']);
const SKIPPED_DIRECTORIES = Object.freeze(['node_modules', 'vendor', '.git']);

/**
 * 太短的值不掃：一個 8 個字的商店代號有可能剛好是某個檔案裡的普通字串，
 * 而那種誤報會訓練人忽略這個警告。真正的祕密（HashKey 32 / HashIV 16）都夠長。
 */
const MIN_LENGTH = 12;

function* filesUnder(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      yield* filesUnder(path.join(dir, entry.name));
      continue;
    }
    if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

/**
 * @param {Record<string, string|null|undefined>} secrets 環境變數名稱 → 值
 * @param {{ dir?: string }} [options]
 * @returns {Array<{ name: string, file: string }>} 命中的（空陣列 ＝ 乾淨）
 */
function findHardcodedSecrets(secrets, { dir = SOURCE_DIR } = {}) {
  const wanted = Object.entries(secrets).filter(
    ([, value]) => typeof value === 'string' && value.length >= MIN_LENGTH,
  );

  if (wanted.length === 0) return [];

  const hits = [];

  for (const file of filesUnder(dir)) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      // 讀不到就跳過：這是一道加分的檢查，不該讓服務起不來
      continue;
    }

    for (const [name, value] of wanted) {
      if (source.includes(value)) hits.push({ name, file: path.relative(dir, file) });
    }
  }

  return hits;
}

/**
 * @param {{ logger: object, secrets: Record<string, string|null|undefined>, dir?: string }} input
 * @returns {number} 命中幾筆（測試用）
 */
function warnOnHardcodedSecrets({ logger, secrets, dir }) {
  let hits;
  try {
    hits = findHardcodedSecrets(secrets, dir === undefined ? {} : { dir });
  } catch (error) {
    logger.warn(`金鑰硬編檢查跑不起來（不影響服務）：${error.message}`);
    return 0;
  }

  for (const hit of hits) {
    // ⛔ 只講「哪個變數、哪個檔案」。值本身不准進 log。
    logger.warn(
      `⛔ ${hit.name} 的值出現在 src/${hit.file} —— 金鑰不准寫進程式碼裡。` +
        '請把它從原始碼移除，然後**輪替那把金鑰**（它已經進過 git 歷史了）。',
    );
  }

  return hits.length;
}

module.exports = { findHardcodedSecrets, warnOnHardcodedSecrets, MIN_LENGTH, SOURCE_DIR };
