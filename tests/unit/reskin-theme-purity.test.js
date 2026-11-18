'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * ⛔ **SPEC-reskin §1 最重要的那一條紀律，靠這支測試釘著。**
 *
 * > 版型層不准出現任何 templatemo 的字樣或選擇器。
 * > 這條是這份規格最重要的紀律，違反了整個價值就沒了。
 *
 * 為什麼值得一條測試：使用者真正在做的是**自己的**模板商城，被代理的站只是
 * 「真實感的假資料」（規格 §0）。版型與商城機制是資產 —— 之後把資料來源換成
 * 他自己的模板庫就能上線；抽取規則是可拋棄的那一層。
 * 一旦有人為了省事在版型裡寫一個上游的 class，那個「換掉資料來源就能上線」
 * 的性質就沒了，而且**沒有任何人會發現** —— 畫面看起來一模一樣。
 *
 * 所以這條不是風格檢查，是在守一個架構性質。靠人記得是不夠的。
 */

const THEMES_DIR = path.join(__dirname, '..', '..', 'src', 'reskin', 'themes');
/** 版型的瀏覽器端（購物車／結帳、無限載入）跟版型同一條紀律 */
const BROWSER_SCRIPTS = ['reskin-shop.js', 'reskin-feed.js'].map((name) =>
  path.join(__dirname, '..', '..', 'src', 'public', name),
);

/**
 * 被禁的字樣。
 *
 * 前兩個是上游的名字（含使用者改寫後的那個變體）；其餘是它實際用的
 * class / id 前綴 —— 那些就是「上游選擇器」長的樣子。
 */
const FORBIDDEN = Object.freeze([
  'templatemo',
  'templatee',
  'thumbnail_270',
  'tm_silver',
  'tn_desc',
  'tm-dl',
  'tm-view',
  'tm-preview',
  'paging_info',
]);

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

test('版型層不含任何上游的字樣或選擇器', () => {
  const files = [...filesUnder(THEMES_DIR), ...BROWSER_SCRIPTS];
  assert.ok(files.length >= 6, `掃到的檔案太少，是不是路徑錯了？${files.join(', ')}`);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8').toLowerCase();

    for (const word of FORBIDDEN) {
      assert.ok(
        !source.includes(word),
        `${path.relative(THEMES_DIR, file)} 出現了「${word}」—— 版型層不准知道資料來源是誰（SPEC-reskin §1）`,
      );
    }
  }
});

/**
 * 反過來也要成立：版型只能從**資料模型**拿東西。
 *
 * 這條擋的是「偷偷繞過資料模型」的那種作法 —— 版型層自己 require 抽取層、
 * 或自己去讀 DB。那樣的話資料模型就不再是唯一的界線了。
 */
const EXTRACTION_MODULES = Object.freeze(['dom.js', 'query.js', 'config.js', 'extract.js', 'url.js']);

test('版型層不 require 抽取層，也不碰 DB', () => {
  for (const file of filesUnder(THEMES_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    const required = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);

    for (const target of required) {
      const basename = path.basename(target);

      assert.ok(
        !EXTRACTION_MODULES.includes(basename),
        `${path.basename(file)} require 了抽取層的 ${basename} —— 版型只能認資料模型`,
      );
      assert.ok(
        !target.includes('/db/'),
        `${path.basename(file)} require 了 ${target} —— 版型不准碰 DB`,
      );
    }
  }
});

/**
 * ⛔ 購買區是版型的一部分，不是浮動層。
 *
 * 上一輪就是拿 `position: fixed` 的浮動面板貼在上游頁面上，使用者的評語是
 * 「你怎麼另外加開一個鬼浮動面板」。重繪之後那塊在 `.lm-product` 的第二欄，
 * 跟主圖同一個 grid。唯一允許的覆蓋層是按下載才開的 `<dialog>`（它的
 * 定位是瀏覽器給的，CSS 裡沒有 `position: fixed`）與一閃而過的 toast。
 */
test('購買區不是浮動層：CSS 裡唯一的 fixed 是 toast', () => {
  const { THEME_CSS } = require('../../src/reskin/themes/mall/css.js');

  const fixed = [...THEME_CSS.matchAll(/([^{}]+)\{[^{}]*position:fixed/g)].map((match) =>
    match[1].trim(),
  );

  assert.deepEqual(fixed, ['.lm-toast'], `不該有浮動層：${fixed.join(', ')}`);

  const product = require('../../src/reskin/themes/mall/product.js');
  assert.ok(typeof product.renderBuy === 'function');
  assert.ok(!THEME_CSS.includes('.lm-buy{position'), '購買區不准自己定位');
});
