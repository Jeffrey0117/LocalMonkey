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
