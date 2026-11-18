'use strict';

/**
 * templatemo 的那一組規則（SPEC-rules §3）。
 *
 * 這是**資料不是程式** —— 使用者看著自己代理的站逐項指出來的改造需求。放進
 * repo 的理由有兩個：① `scripts/seed-site-rules.js` 可以一次配好，不用在 UI
 * 點二十次 ② `tests/integration/rules-templatemo.test.js` 拿真實頁面的
 * fixture 逐條驗它，所以規格 §3 的那張表有東西釘著。
 *
 * 每一條都附上「為什麼是這個選擇器」—— 幾個都是實測踩出來的：
 *
 * - ⛔ 詳情頁有**兩個元素共用 `id="tm-download"`**（真的下載按鈕 + AI 提示
 *   生成器）。HTML 不合法，但瀏覽器的 CSS `#tm-download` 會兩個都命中，
 *   所以要藏的那顆只能用 `a[href*="ai-website-prompt-generator"]`。
 * - ⛔ footer 的連結之間是**純文字節點的 ` - `**，CSS 藏不掉。五個連結藏完會
 *   剩一排孤兒的 `-`，所以要多一條 `text-rewrite` 把它們收掉。
 * - ⛔ 標語與「實時預覽」各有**兩條**規則：中文那條對著翻譯後的文字，英文那條
 *   對著還沒翻到的狀態。只配中文的話，第一次造訪（或翻譯關掉）時規則完全不會中。
 */

/** 卡片標題：`634 Lantern River` → `Lantern River[634]`（規格 §3.2） */
const CARD_TITLE_PATTERN = '^(\\d{2,4})\\s+(.+)$';

/**
 * §10.1 的 logo 字樣。
 *
 * 使用者要的是「把 templatemo 的 logo 換成我們的 templatee」，但他沒給圖 ——
 * 所以用 CSS 畫。`hide` 掉那張 PNG，再用 `::before` / `::after` 疊出字樣。
 *
 * 兩個顏色都是從**原本那張 PNG 量出來的**（System.Drawing 掃 9982 bytes 的
 * `templatemo-logo-new.png`：白字 `#FFFFFF` 1877 px、`mo` 的螢光黃綠
 * `#CCFF00` 593 px）。所以 `ee` 用 `#CCFF00` 不是猜的，是原站的調性。
 *
 * 尺寸也是量的：圖是 280×60，字的 ink box 是 x 8..268 / y 8..51
 * （寬 261、高 44，含 `p` 的下伸部）。所以 `<a>` 撐成 280×60、字從左邊 8px 開始。
 *
 * `font-size: 54px` 不是估的 —— 在真瀏覽器上量 Raleway 700 的 `templatee`：
 * 44px→211、46px→221、48px→231、50px→241、52px→251、**54px→261**，
 * 剛好等於原 logo 的 ink 寬度。
 *
 * ⛔ `font-weight` 用 700 不是 800：原站只從 Google Fonts 載
 * Raleway 300/400/500/600/700（實測 `document.fonts` 裡 700 是 loaded），
 * 寫 800 會變成瀏覽器自己合成的假粗體。
 */
/**
 * §10.2 收掉多餘的空白。**每一個數字都是在真瀏覽器上量的**
 * （`getBoundingClientRect` + `documentElement.scrollHeight`）。
 *
 * ⛔ 一開始的假設是「`display: none` 只藏元素，容器的高度與 margin 還在」——
 * 量完發現**不是**那樣：`.tm-dl-grey` / `.tm-dl-grey-premium` 這些容器的子元素
 * 都是 float，所以它們本來就是 0 高，藏掉子元素不留空間。
 *
 * 真正的空白是兩個**從來沒被填滿的廣告位**：`.tm_banner` 自己帶
 * `min-height: 300px`，而廣告腳本是絕對網址（googlesyndication 等）、不經過
 * 代理也載不起來 → 永遠是 300px 的純白。首頁與詳情頁各兩個 ＝ 600px。
 *
 * 實測（首頁 1920×911）：hero 到第一排卡片的距離 380px → 80px，
 * 整頁高度 3733px → 3073px（連下面那條 60px 一起收掉）。
 */
const COLLAPSE_BLANK_CSS = [
  '/* 空的廣告位：min-height: 300px 撐著，但裡面永遠什麼都沒有 */',
  '.tm_banner { display: none !important; }',
  '/* 分享按鈕藏掉之後，只為了隔開它而存在的那條 60px 間隔條還在 */',
  '.sharethis-inline-share-buttons + .templatemo_clear { display: none !important; }',
].join('\n');

const LOGO_WORDMARK_CSS = [
  '.templatemo-logo > a {',
  '  display: block;',
  '  width: 280px;',
  '  height: 60px;',
  '  line-height: 60px;',
  '  padding-left: 8px;',
  '  box-sizing: border-box;',
  "  font-family: 'Raleway', Verdana, Arial, Helvetica, sans-serif;",
  '  font-weight: 700;',
  '  font-size: 54px;',
  '  letter-spacing: -1px;',
  '  white-space: nowrap;',
  '  text-decoration: none;',
  '}',
  '.templatemo-logo > a::before { content: "templat"; color: #FFFFFF; }',
  '.templatemo-logo > a::after  { content: "ee"; color: #CCFF00; }',
].join('\n');

/**
 * footer 的孤兒分隔符：把一段文字尾巴的 `-` 收掉。
 * `-` 自己一段的時候整段變空字串，連著版權那句的時候只掉尾巴那一個。
 */
const TRAILING_SEPARATOR_PATTERN = '\\s*-\\s*$';

const TEMPLATEMO_RULES = Object.freeze([
  /* ---------------------------- §3.1 首頁 header ---------------------------- */
  {
    kind: 'text-replace',
    pattern: '免費 HTML CSS 網站模板',
    replacement: '超級齊全的 HTML CSS 網站模板',
    scope: '.templatemo-slogan',
    note: '§3.1 標語（翻譯後的文字）',
  },
  {
    kind: 'text-replace',
    pattern: 'Free HTML CSS Website Templates',
    replacement: '超級齊全的 HTML CSS 網站模板',
    // ⛔ 一定要限定範圍：這個片語也出現在 <title>（「Download 620+ Free HTML
    //    CSS Website Templates | TemplateMo 2026」），不限定會把標題一起改掉
    scope: '.templatemo-slogan',
    note: '§3.1 標語（還沒翻到的時候）',
  },
  {
    kind: 'hide',
    pattern: '.tm-menu',
    note: '§3.1 右上四顆按鈕（整個容器藏掉）',
  },

  /* ------------------------- §10.1 logo 換成 templatee ------------------------- */
  {
    kind: 'hide',
    pattern: '.templatemo-logo img',
    note: '§10.1 原本的 logo PNG（字樣由下一條 CSS 畫出來）',
  },
  {
    kind: 'css',
    pattern: LOGO_WORDMARK_CSS,
    note: '§10.1 用 ::before / ::after 畫 templatee 字樣（ee 是原 logo 的 #CCFF00）',
  },

  /* --------------------------- §3.2 模板卡片標題 --------------------------- */
  {
    kind: 'text-rewrite',
    pattern: CARD_TITLE_PATTERN,
    replacement: '$2[$1]',
    // ⛔ 不能全站套：別的地方有「2026 年…」這種開頭是數字的句子。
    // ⛔ 兩種容器都要寫：清單頁的卡片是 `.thumbnail_270`，詳情頁底下那排
    //    「More Website Templates」是 `.tm_silver_360`。只寫前者的話在詳情頁
    //    會看到沒改過的標題 —— 這是開真瀏覽器才發現的。
    scope: '.thumbnail_270 h2, .tm_silver_360 h2',
    note: '§3.2 卡片標題改成「名稱[編號]」（清單頁與詳情頁的相關模板）',
  },

  /* ---------------------------- §3.3 詳情頁按鈕 ---------------------------- */
  {
    kind: 'text-replace',
    pattern: '實時預覽',
    replacement: '預覽',
    scope: '#tm-view',
    note: '§3.3 實時預覽 → 預覽（翻譯後的文字）',
  },
  {
    kind: 'text-replace',
    pattern: 'Live View',
    replacement: '預覽',
    scope: '#tm-view',
    note: '§3.3 實時預覽 → 預覽（還沒翻到的時候）',
  },
  {
    kind: 'hide',
    pattern: 'a[href*="/screenshots/"]',
    note: '§3.3 全尺寸截圖',
  },
  {
    kind: 'hide',
    pattern: 'a[href*="ltcclock.com"]',
    note: '§3.3 聯絡表單 PHP 腳本（廣告）',
  },
  {
    kind: 'hide',
    pattern: 'a[href*="tooplate.com"]',
    note: '§3.3 HTML 模版（廣告）',
  },
  {
    kind: 'hide',
    pattern: 'a[href*="timermo.com"]',
    note: '§3.3 / §3.4 您的計時器與在線計時器（廣告）',
  },
  {
    kind: 'hide',
    // ⛔ 不能用 #tm-download：那一頁有兩個元素共用這個 id，會把真的下載按鈕一起藏掉
    pattern: 'a[href*="ai-website-prompt-generator"]',
    note: '§3.3 AI 網站提示生成器（跟下載按鈕共用 id，只能用 href 認）',
  },

  /* --------------- §10.3 詳情頁的英文樣板文 + 使用者自己加的兩條 --------------- */
  {
    kind: 'hide',
    /**
     * 「Lumen Eighty 模板 is 100% free to download for anyone. You are allowed
     * to…」那一整段。每個模板一句、名字內嵌，600+ 個模板就是 600+ 段。
     *
     * ⛔ 為什麼用 `:has(> a[href*=…])` 而不是 `#tm-dl-box p:nth-of-type(2)`：
     * nth-of-type 靠「Tags 那段一定在」，而那是假設。這一條是**內容定位**的 ——
     * 它就是「直接連回這個模板自己」的那一段（實測 tm-628 與 tm-634 的
     * `#tm-dl-box` 裡只有這一個 `<p>` 有這種直接子連結；breadcrumb 那個是 h2）。
     * 代理不改寫絕對網址，所以 `templatemo.com/tm-` 在送出去的 HTML 裡還在。
     */
    pattern: '#tm-dl-box p:has(> a[href*="templatemo.com/tm-"])',
    note: '§10.3 詳情頁那段英文樣板文（每個模板一句、名字內嵌，翻它是浪費）',
  },
  {
    kind: 'hide',
    pattern: '.sharethis-inline-share-buttons',
    note: '§10.3 分享按鈕（使用者自己加的）',
  },
  {
    kind: 'hide',
    pattern: '.tm-dl-grey-premium',
    note: '§10.3 首頁那排 tag 捷徑（使用者自己加的）',
  },

  /* --------------------------- §10.2 收掉多餘的空白 --------------------------- */
  {
    kind: 'css',
    pattern: COLLAPSE_BLANK_CSS,
    note: '§10.2 空的廣告位（min-height:300px，×2）與孤兒間隔條 —— 實測整頁省 660px',
  },

  /* ------------------------------ §3.4 Footer ------------------------------ */
  {
    kind: 'hide',
    pattern: '#footer a[href*="/about"]',
    note: '§3.4 關於',
  },
  {
    kind: 'hide',
    pattern: '#footer a[href*="/privacy-policy"]',
    note: '§3.4 隱私政策',
  },
  {
    kind: 'hide',
    pattern: '#footer a[href*="/contact"]',
    note: '§3.4 聯絡我們',
  },
  {
    kind: 'hide',
    pattern: '#footer a[href*="sitemap"]',
    note: '§3.4 XML 網站地圖',
  },
  {
    kind: 'text-rewrite',
    pattern: TRAILING_SEPARATOR_PATTERN,
    replacement: '',
    scope: '#footer',
    note: '§3.4 把藏掉連結之後剩下的孤兒 - 收掉（CSS 藏不掉純文字節點）',
  },

  /* --------------------------- §3.5 全站文字替換 --------------------------- */
  {
    kind: 'text-replace',
    pattern: 'templatemo',
    replacement: 'templatee',
    // 大小寫風格跟著原文走（TemplateMo → Templatee、TEMPLATEMO → TEMPLATEE）
    note: '§3.5 templatemo → templatee（全站）',
  },
]);

/**
 * §3.6：logo 是一張 PNG，文字替換換不掉它。
 * 只做 §3.5 的話使用者會看到「內文都改了、左上角最大那個還是舊的」。
 */
const TEMPLATEMO_LOGO_PATH = '/images/templatemo-logo-new.png';

module.exports = { TEMPLATEMO_RULES, TEMPLATEMO_LOGO_PATH, CARD_TITLE_PATTERN, TRAILING_SEPARATOR_PATTERN };
