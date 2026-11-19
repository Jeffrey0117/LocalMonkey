'use strict';

/**
 * 版型的樣式表。由 `/__lm/reskin/mall.css` 送出去（外部檔案而不是內嵌：
 * 可以被瀏覽器快取、而且不會跟上游的 `</style>` 攪在一起）。
 *
 * ⛔ **這個檔案與整個 `themes/` 目錄不准出現任何上游的字樣或選擇器。**
 * 它認得的 class 全部是我們自己產生的（前綴 `lm-`），所以把資料來源換成
 * 別的站、甚至換成使用者自己的模板庫，這份 CSS 一個字都不用改
 * （規格 §1 的紀律，也是這整輪工作唯一的資產）。
 *
 * 抓的是**版面骨架與間距**：頂欄 + 搜尋列、白底卡片網格、左圖右購買區的
 * 商品頁、黏在版面裡（不是 `position: fixed`）的購買區。
 *
 * ⛔ **顏色只准寫在 `TOKENS` 裡**（SPEC-reskin-v2 §1：「整套色票集中在一個
 * 地方，之後要換色改一處就好」）。下面每一塊用的都是 `var(--lm-…)` ——
 * 看到任何一個字面色碼跑出 TOKENS 之外，就是下一次換色的時候會漏掉的那一個。
 */

/**
 * 色票。
 *
 * 兩個色、各一個用途，刻意不多：
 *
 * - **深靛藍**是骨架（頂欄、品牌、對話框標頭）—— 底色深、不搶商品縮圖的注意力。
 * - **青藍**是唯一的強調色（價格、主要動作、選中狀態）。
 *
 * 為什麼是這兩個：這個站賣的是網頁模板，受眾是開發者／設計者，所以走
 * 深色調 + 一個鮮明強調色，而不是電商那種高彩度暖色（SPEC-reskin-v2 §1）。
 * 兩個色配白底的對比都過得了 AA（青藍 700 對白 5.3:1，白字對青藍 700 也是），
 * 所以價格與按鈕上的字不用另外挑色。
 */
const TOKENS = `
:root{
  --lm-brand:#312e81;
  --lm-brand-dark:#1e1b4b;
  --lm-brand-soft:#eef2ff;
  --lm-accent:#0e7490;
  --lm-accent-dark:#155e75;
  --lm-accent-soft:#ecfeff;
  --lm-ink:#0f172a;
  --lm-muted:#64748b;
  --lm-line:#e2e8f0;
  --lm-bg:#f1f5f9;
  --lm-card:#fff;
  --lm-shadow:0 1px 2px rgba(15,23,42,.08);
  --lm-shadow-lift:0 8px 24px rgba(15,23,42,.14);
  --lm-radius:8px;
  --lm-radius-sm:4px;
  --lm-max:1200px;
}
`;

const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--lm-bg);color:var(--lm-ink);
  font:14px/1.5 "Helvetica Neue",Helvetica,Arial,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
[hidden]{display:none !important}
.lm-wrap{max-width:var(--lm-max);margin:0 auto;padding:0 12px}
.lm-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/*
 * 頂欄：品牌 + 搜尋列 + 購物車。
 *
 * ⛔ 上一版還有一排「賣家中心 / 下載我們的 App / 訪客」的細字列 ——
 * 那是在模仿別人的電商，而這個站沒有賣家也沒有 App（SPEC-reskin-v2 §2）。
 * 整列拿掉了，所以這裡也沒有 `.lm-top-thin`。
 */
const HEADER = `
.lm-top{background:linear-gradient(100deg,var(--lm-brand-dark),var(--lm-brand));color:#fff}
.lm-head{
  display:flex;align-items:center;gap:24px;flex-wrap:wrap;
  padding:14px 0 16px;
}
.lm-brand{display:flex;align-items:baseline;gap:8px;flex:0 0 auto}
.lm-brand b{font-size:24px;letter-spacing:-.4px;font-weight:700}
.lm-brand i{font-style:normal;font-size:12px;opacity:.8;border-left:1px solid rgba(255,255,255,.35);padding-left:8px}
.lm-search{flex:1 1 auto;min-width:0}
.lm-search-box{display:flex;background:#fff;border-radius:var(--lm-radius);padding:3px}
.lm-search-box input{
  flex:1 1 auto;min-width:0;border:0;outline:0;padding:9px 10px;
  font:inherit;color:var(--lm-ink);background:transparent;
}
.lm-search-box button{
  flex:0 0 auto;background:var(--lm-accent);color:#fff;
  padding:8px 22px;border-radius:var(--lm-radius-sm);font-size:15px;
}
.lm-search-box button:hover{background:var(--lm-accent-dark)}
.lm-search-box[data-inert="1"] input{color:var(--lm-muted)}
.lm-search-note{font-size:11px;opacity:.8;margin-top:5px}
.lm-cart{
  flex:0 0 auto;position:relative;display:flex;align-items:center;
  gap:6px;font-size:14px;padding:4px 2px;
}
.lm-cart-count{
  background:#fff;color:var(--lm-brand);border-radius:999px;
  padding:0 7px;font-size:12px;font-weight:700;line-height:18px;
}

/*
 * 窄螢幕：品牌 + 搜尋 + 購物車擠不進一行。
 *
 * 實測（390px）：那一列硬撐到 440px，於是整個 body 可以左右捲 ——
 * 而且在桌機上完全看不出來。所以搜尋列在這個寬度要自己佔滿一行
 * （order 讓它掉到品牌與購物車下面），品牌字級也縮一號。
 *
 * ⛔ 這整個檔案的註解在 template literal 裡面，所以不准出現反引號
 * （會把字串提前關掉，而錯誤訊息只會說某個識別字 Unexpected）。
 */
@media(max-width:760px){
  .lm-head{gap:10px 12px;padding-bottom:12px}
  .lm-brand b{font-size:20px}
  .lm-brand i{display:none}
  .lm-search{flex:1 0 100%;order:3}
  .lm-cart{margin-left:auto}
}
`;

/* 分類列（＝標籤），橫向可捲 */
const CATEGORIES = `
.lm-cats{background:var(--lm-card);box-shadow:var(--lm-shadow);margin:16px 0;border-radius:var(--lm-radius)}
.lm-cats-inner{display:flex;align-items:center;gap:10px;padding:14px 12px;overflow-x:auto}
.lm-cats h2{font-size:13px;color:var(--lm-muted);margin:0;white-space:nowrap;font-weight:400}
.lm-pill{
  flex:0 0 auto;border:1px solid var(--lm-line);border-radius:999px;
  padding:5px 14px;font-size:13px;color:#334155;background:#fff;white-space:nowrap;
}
.lm-pill:hover{border-color:var(--lm-accent);color:var(--lm-accent)}
`;

/* 卡片網格：手機 2 欄、平板 3 欄、桌機 6 欄（規格 §4.1） */
const GRID = `
.lm-section-head{
  display:flex;align-items:baseline;justify-content:space-between;
  gap:12px;padding:14px 0;
}
.lm-section-title{font-size:18px;margin:0;font-weight:600;color:var(--lm-ink)}
.lm-section-head p{margin:0;font-size:13px;color:var(--lm-muted)}
.lm-grid{
  display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr));
  padding-bottom:8px;
}
@media(min-width:600px){.lm-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:900px){.lm-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(min-width:1100px){.lm-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}

.lm-card{
  background:var(--lm-card);border:1px solid var(--lm-line);border-radius:var(--lm-radius);
  display:flex;flex-direction:column;position:relative;overflow:hidden;
  transition:box-shadow .12s,transform .12s,border-color .12s;
}
.lm-card:hover{border-color:var(--lm-accent);box-shadow:var(--lm-shadow-lift);transform:translateY(-2px);z-index:1}
.lm-thumb{position:relative;aspect-ratio:1/1;background:#f8fafc;overflow:hidden}
.lm-thumb img{width:100%;height:100%;object-fit:cover}
.lm-badge{
  position:absolute;top:8px;right:8px;background:rgba(15,23,42,.72);color:#fff;
  font-size:11px;padding:2px 7px;border-radius:999px;line-height:1.5;
}
.lm-badge-free{
  position:absolute;top:8px;left:8px;background:var(--lm-accent-soft);color:var(--lm-accent-dark);
  font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;
}
.lm-card-body{padding:10px;display:flex;flex-direction:column;gap:6px;flex:1 1 auto}
.lm-card-name{
  font-size:13px;line-height:1.4;color:var(--lm-ink);margin:0;font-weight:500;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;min-height:2.8em;
}
.lm-card-tags{display:flex;gap:4px;flex-wrap:wrap;overflow:hidden;max-height:1.7em}
.lm-tag-mini{font-size:10px;color:var(--lm-brand);background:var(--lm-brand-soft);padding:1px 6px;border-radius:999px}
/* 價格一行、已售出自己一行（SPEC-reskin-v2 §4） */
.lm-card-foot{display:flex;flex-direction:column;gap:2px;margin-top:auto}
.lm-price{color:var(--lm-accent);font-size:16px;font-weight:600;white-space:nowrap}
.lm-price small{font-size:11px;font-weight:400}
.lm-price-was{color:#94a3b8;font-size:11px;font-weight:400;text-decoration:line-through;margin-left:4px}
.lm-sold{font-size:11px;color:var(--lm-muted);white-space:nowrap}
.lm-empty{background:#fff;padding:40px 16px;text-align:center;color:var(--lm-muted);border-radius:var(--lm-radius)}
`;

/*
 * 無限載入的尾巴（SPEC-reskin-v2 §7）。
 *
 * ⛔ 三種狀態都要畫得出來：載入中、失敗（**有重試按鈕**）、沒有更多了。
 * 少了任何一種，使用者看到的都是「卡住」而分不出是哪一種。
 * JS 沒跑起來的時候 `.lm-feed-link` 是唯一的退路（一個真的連結）。
 */
const FEED = `
.lm-feed{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 0 44px;text-align:center}
.lm-feed-status{font-size:13px;color:var(--lm-muted);min-height:20px}
.lm-feed-spin{
  width:20px;height:20px;border:2px solid var(--lm-line);border-top-color:var(--lm-accent);
  border-radius:50%;display:inline-block;vertical-align:-4px;margin-right:8px;
  animation:lm-spin .8s linear infinite;
}
@keyframes lm-spin{to{transform:rotate(360deg)}}
.lm-feed-retry,.lm-feed-link{
  border:1px solid var(--lm-line);background:#fff;color:var(--lm-ink);
  padding:8px 18px;border-radius:999px;font-size:13px;display:inline-block;
}
.lm-feed-retry:hover,.lm-feed-link:hover{border-color:var(--lm-accent);color:var(--lm-accent)}
.lm-feed-page{font-size:12px;color:var(--lm-muted)}
`;

/* 商品頁：左圖右購買區（規格 §4.2） */
const PRODUCT = `
.lm-crumb{font-size:13px;color:var(--lm-muted);padding:14px 0}
.lm-crumb a:hover{color:var(--lm-accent)}
.lm-crumb span{margin:0 6px;opacity:.6}

.lm-product{
  background:var(--lm-card);box-shadow:var(--lm-shadow);border-radius:var(--lm-radius);
  display:grid;gap:0;grid-template-columns:minmax(0,1fr);overflow:hidden;
}
@media(min-width:900px){
  .lm-product{grid-template-columns:minmax(0,440px) minmax(0,1fr)}
}
.lm-gallery{padding:16px}
.lm-gallery-main{
  aspect-ratio:1/1;background:#f8fafc;overflow:hidden;
  border:1px solid var(--lm-line);border-radius:var(--lm-radius-sm);
}
.lm-gallery-main img{width:100%;height:100%;object-fit:cover;object-position:top center}
.lm-gallery-strip{display:flex;gap:8px;margin-top:10px;overflow-x:auto}
.lm-gallery-strip button{
  flex:0 0 auto;width:62px;height:62px;border:1px solid var(--lm-line);
  background:#f8fafc;padding:0;overflow:hidden;border-radius:var(--lm-radius-sm);
}
.lm-gallery-strip button[aria-current="true"]{border-color:var(--lm-accent)}
.lm-gallery-strip img{width:100%;height:100%;object-fit:cover}

.lm-buy{padding:20px 24px 24px;display:flex;flex-direction:column;gap:16px;min-width:0}
.lm-buy-title{font-size:21px;line-height:1.4;margin:0;font-weight:600}
.lm-stats-row{display:flex;align-items:center;gap:14px;font-size:13px;color:var(--lm-muted);flex-wrap:wrap}
.lm-stats-row b{color:var(--lm-accent);font-weight:600}
.lm-price-block{
  background:var(--lm-accent-soft);padding:14px 16px;border-radius:var(--lm-radius-sm);
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
}
.lm-price-block .lm-price{font-size:30px}
.lm-price-block .lm-price-was{font-size:15px}
.lm-save{background:var(--lm-accent);color:#fff;font-size:11px;padding:2px 7px;border-radius:999px;font-weight:700}

.lm-field{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.lm-field>h2{
  flex:0 0 78px;font-size:13px;color:var(--lm-muted);margin:7px 0 0;font-weight:400;
}
.lm-field-body{flex:1 1 220px;min-width:0;display:flex;flex-wrap:wrap;gap:8px}
.lm-plan{
  border:1px solid var(--lm-line);background:#fff;padding:8px 12px;border-radius:var(--lm-radius-sm);
  text-align:left;min-width:132px;position:relative;
}
.lm-plan:hover{border-color:var(--lm-accent);color:var(--lm-accent)}
.lm-plan[aria-pressed="true"]{border-color:var(--lm-accent);color:var(--lm-accent);background:var(--lm-accent-soft)}
.lm-plan b{display:block;font-size:13px;font-weight:600}
.lm-plan small{display:block;font-size:11px;color:var(--lm-muted);margin-top:2px}
.lm-plan[aria-pressed="true"] small{color:var(--lm-accent)}

.lm-qty{display:flex;align-items:center;gap:0;border:1px solid var(--lm-line);border-radius:var(--lm-radius-sm);overflow:hidden}
.lm-qty button{width:32px;height:32px;font-size:16px;color:#334155}
.lm-qty button:hover{background:#f8fafc}
.lm-qty output{width:50px;text-align:center;font-size:14px;border-left:1px solid var(--lm-line);border-right:1px solid var(--lm-line);line-height:32px}

.lm-actions{display:flex;gap:12px;flex-wrap:wrap;padding-top:4px}
.lm-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:0 22px;height:48px;border-radius:var(--lm-radius);font-size:15px;font-weight:500;
}
.lm-btn-ghost{background:var(--lm-brand-soft);color:var(--lm-brand);border:1px solid var(--lm-brand)}
.lm-btn-ghost:hover{background:#e0e7ff}
.lm-btn-solid{background:var(--lm-accent);color:#fff}
.lm-btn-solid:hover{background:var(--lm-accent-dark)}
.lm-btn-flat{background:#fff;color:#334155;border:1px solid var(--lm-line);height:40px;font-size:14px}
.lm-btn-flat:hover{border-color:var(--lm-accent);color:var(--lm-accent)}
.lm-note{font-size:12px;color:var(--lm-muted);margin:0}
/* 金流狀態：要跟按鈕在同一塊、而且看得出來是「狀態」不是說明文 */
.lm-pay-note{padding:8px 11px;border-radius:var(--lm-radius-sm);background:#f8fafc;border:1px dashed var(--lm-line)}

/* 店家資訊列 */
.lm-shop{
  background:var(--lm-card);box-shadow:var(--lm-shadow);margin-top:16px;border-radius:var(--lm-radius);
  padding:20px 24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap;
}
.lm-shop-avatar{
  width:56px;height:56px;border-radius:var(--lm-radius);background:var(--lm-brand);
  color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:22px;font-weight:700;flex:0 0 auto;
}
.lm-shop-main{flex:1 1 200px;min-width:0}
.lm-shop-main b{display:block;font-size:16px;font-weight:600}
.lm-shop-main p{margin:3px 0 0;font-size:12px;color:var(--lm-muted)}
.lm-shop-metrics{display:flex;gap:28px;flex-wrap:wrap}
.lm-shop-metrics div{font-size:12px;color:var(--lm-muted)}
.lm-shop-metrics b{display:block;color:var(--lm-accent);font-size:15px;font-weight:600}

/* 下方：描述與規格表 */
.lm-panel{background:var(--lm-card);box-shadow:var(--lm-shadow);margin-top:16px;border-radius:var(--lm-radius);overflow:hidden}
.lm-panel>h2{
  margin:0;padding:14px 20px;background:#f8fafc;border-bottom:1px solid var(--lm-line);
  font-size:15px;font-weight:600;letter-spacing:.2px;color:var(--lm-ink);
}
.lm-panel-body{padding:20px}
.lm-desc{font-size:14px;line-height:1.9;color:#334155;white-space:pre-wrap;margin:0;overflow-wrap:break-word}
.lm-specs{width:100%;border-collapse:collapse;font-size:14px}
.lm-specs th,.lm-specs td{text-align:left;padding:8px 10px;vertical-align:top}
.lm-specs th{color:var(--lm-muted);font-weight:400;width:140px;white-space:nowrap}
.lm-specs tr+tr th,.lm-specs tr+tr td{border-top:1px solid var(--lm-line)}
.lm-tags{display:flex;gap:6px;flex-wrap:wrap}
.lm-tag{border:1px solid var(--lm-line);padding:2px 10px;font-size:12px;color:#334155;border-radius:999px}
.lm-tag:hover{border-color:var(--lm-accent);color:var(--lm-accent)}
.lm-scroll-x{overflow-x:auto}
`;

/* 結帳面板 —— 一個真的 <dialog>，不是貼在頁面上的浮動層 */
const DIALOG = `
.lm-dialog{
  border:0;border-radius:var(--lm-radius);padding:0;max-width:440px;width:calc(100% - 32px);
  box-shadow:0 10px 40px rgba(15,23,42,.35);color:var(--lm-ink);
}
.lm-dialog::backdrop{background:rgba(15,23,42,.55)}
.lm-dialog-head{background:var(--lm-brand);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.lm-dialog-head b{font-size:16px;font-weight:600}
.lm-dialog-head button{color:#fff;font-size:20px;line-height:1;padding:0 4px}
.lm-dialog-body{padding:18px 20px 20px;display:flex;flex-direction:column;gap:12px}
.lm-dialog-body p{margin:0;font-size:13px;color:var(--lm-muted);line-height:1.7}
.lm-dialog-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px}
.lm-dialog-line em{font-style:normal;color:var(--lm-accent);font-size:20px;font-weight:600}
.lm-dialog-body label{font-size:13px;display:flex;flex-direction:column;gap:5px}
.lm-dialog-body input{
  border:1px solid var(--lm-line);border-radius:var(--lm-radius-sm);padding:10px 12px;
  font:inherit;color:var(--lm-ink);outline-offset:2px;
}
.lm-dialog-body input:focus-visible{outline:2px solid var(--lm-accent);border-color:var(--lm-accent)}
.lm-dialog-error{color:#b91c1c;font-size:13px}
.lm-dialog-foot{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
`;

const TOAST = `
.lm-toast{
  position:fixed;left:50%;bottom:32px;transform:translateX(-50%);
  background:rgba(15,23,42,.9);color:#fff;padding:12px 20px;border-radius:var(--lm-radius);
  font-size:14px;z-index:60;max-width:calc(100% - 32px);text-align:center;
}
`;

const FOOTER = `
.lm-foot{
  background:var(--lm-card);border-top:3px solid var(--lm-brand);
  margin-top:28px;padding:26px 0;color:var(--lm-muted);font-size:12px;line-height:1.9;
}
.lm-foot b{display:block;color:#334155;font-size:13px;margin-bottom:4px;font-weight:600}
.lm-foot-cols{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
`;

const THEME_CSS = [TOKENS, BASE, HEADER, CATEGORIES, GRID, FEED, PRODUCT, DIALOG, TOAST, FOOTER]
  .join('')
  // 送出去的是一份靜態檔，縮一下沒壞處（註解已經在 JS 這邊了）
  .replace(/\n\s*/g, '')
  .trim();

module.exports = { THEME_CSS, TOKENS };
