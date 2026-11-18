'use strict';

/**
 * 版型的樣式表。由 `/__lm/reskin/shopee.css` 送出去（外部檔案而不是內嵌：
 * 可以被瀏覽器快取、而且不會跟上游的 `</style>` 攪在一起）。
 *
 * ⛔ **這個檔案與整個 `themes/` 目錄不准出現任何上游的字樣或選擇器。**
 * 它認得的 class 全部是我們自己產生的（前綴 `lm-`），所以把資料來源換成
 * 別的站、甚至換成使用者自己的模板庫，這份 CSS 一個字都不用改
 * （規格 §1 的紀律，也是這整輪工作唯一的資產）。
 *
 * 抓的是**版面骨架與間距**：橘色頂欄 + 搜尋列、白底卡片網格、左圖右購買區的
 * 商品頁、黏在版面裡（不是 `position: fixed`）的購買面板。
 * 刻意不碰任何商標性的東西 —— 沒有 logo、沒有商標字、`#ee4d2d` 是通用的
 * 電商橘（規格 §4 開頭那句）。
 */

/** 通用電商橘。所有顏色集中在這裡，換主色只要動這一段 */
const TOKENS = `
:root{
  --lm-brand:#ee4d2d;
  --lm-brand-dark:#d73211;
  --lm-brand-soft:#fff5f2;
  --lm-ink:#222;
  --lm-muted:#757575;
  --lm-line:#e8e8e8;
  --lm-bg:#f5f5f5;
  --lm-card:#fff;
  --lm-star:#ee4d2d;
  --lm-shadow:0 1px 2px rgba(0,0,0,.09);
  --lm-shadow-lift:0 1px 20px rgba(0,0,0,.14);
  --lm-radius:2px;
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

/* 頂欄：橘底、品牌、搜尋列、購物車 */
const HEADER = `
.lm-top{background:var(--lm-brand);color:#fff}
.lm-top-thin{
  display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;
  font-size:12px;padding:6px 0;opacity:.92;
}
.lm-top-thin span{white-space:nowrap}
.lm-head{
  display:flex;align-items:center;gap:24px;flex-wrap:wrap;
  padding:0 0 16px;
}
.lm-brand{display:flex;align-items:baseline;gap:8px;flex:0 0 auto}
.lm-brand b{font-size:26px;letter-spacing:-.5px;font-weight:700}
.lm-brand i{font-style:normal;font-size:12px;opacity:.85;border-left:1px solid rgba(255,255,255,.5);padding-left:8px}
.lm-search{flex:1 1 auto;min-width:0}
.lm-search-box{display:flex;background:#fff;border-radius:var(--lm-radius);padding:3px}
.lm-search-box input{
  flex:1 1 auto;min-width:0;border:0;outline:0;padding:9px 10px;
  font:inherit;color:var(--lm-ink);background:transparent;
}
.lm-search-box button{
  flex:0 0 auto;background:var(--lm-brand);color:#fff;
  padding:8px 22px;border-radius:var(--lm-radius);font-size:15px;
}
.lm-search-box button:hover{background:var(--lm-brand-dark)}
.lm-search-box[data-inert="1"] input{color:var(--lm-muted)}
.lm-search-note{font-size:11px;opacity:.85;margin-top:5px}
.lm-search-hint{display:flex;gap:12px;font-size:12px;opacity:.9;margin-top:6px;flex-wrap:wrap}
.lm-cart{
  flex:0 0 auto;position:relative;display:flex;align-items:center;
  gap:6px;font-size:14px;padding:4px 2px;
}
.lm-cart-count{
  background:#fff;color:var(--lm-brand);border-radius:10px;
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
.lm-cats{background:var(--lm-card);box-shadow:var(--lm-shadow);margin:16px 0}
.lm-cats-inner{display:flex;align-items:center;gap:10px;padding:14px 12px;overflow-x:auto}
.lm-cats h2{font-size:13px;color:var(--lm-muted);margin:0;white-space:nowrap;font-weight:400}
.lm-pill{
  flex:0 0 auto;border:1px solid var(--lm-line);border-radius:999px;
  padding:5px 14px;font-size:13px;color:#555;background:#fff;white-space:nowrap;
}
.lm-pill:hover{border-color:var(--lm-brand);color:var(--lm-brand)}
`;

/* 卡片網格：手機 2 欄、平板 3 欄、桌機 6 欄（規格 §4.1） */
const GRID = `
.lm-section-head{
  display:flex;align-items:baseline;justify-content:space-between;
  gap:12px;padding:14px 0;
}
.lm-section-head h1{font-size:17px;margin:0;font-weight:500;color:#555}
.lm-section-head p{margin:0;font-size:13px;color:var(--lm-muted)}
.lm-grid{
  display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));
  padding-bottom:8px;
}
@media(min-width:600px){.lm-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:900px){.lm-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(min-width:1100px){.lm-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}

.lm-card{
  background:var(--lm-card);border:1px solid transparent;
  display:flex;flex-direction:column;position:relative;
  transition:box-shadow .1s,transform .1s,border-color .1s;
}
.lm-card:hover{border-color:var(--lm-brand);box-shadow:var(--lm-shadow-lift);transform:translateY(-1px);z-index:1}
.lm-thumb{position:relative;aspect-ratio:1/1;background:#fafafa;overflow:hidden}
.lm-thumb img{width:100%;height:100%;object-fit:cover}
.lm-badge{
  position:absolute;top:0;right:0;background:rgba(238,77,45,.9);color:#fff;
  font-size:11px;padding:3px 6px;line-height:1.3;text-align:center;
}
.lm-badge-free{
  position:absolute;top:0;left:0;background:#ffd400;color:#a33;
  font-size:11px;font-weight:700;padding:3px 6px;
}
.lm-card-body{padding:8px;display:flex;flex-direction:column;gap:6px;flex:1 1 auto}
.lm-card-name{
  font-size:13px;line-height:1.35;color:#000;margin:0;font-weight:400;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;min-height:2.7em;
}
.lm-card-tags{display:flex;gap:4px;flex-wrap:wrap;overflow:hidden;max-height:1.6em}
.lm-tag-mini{font-size:10px;color:var(--lm-brand);background:var(--lm-brand-soft);padding:1px 4px}
.lm-card-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:6px;margin-top:auto}
.lm-price{color:var(--lm-brand);font-size:16px;white-space:nowrap}
.lm-price small{font-size:11px}
.lm-price-was{color:#b0b0b0;font-size:11px;text-decoration:line-through;margin-left:4px}
.lm-sold{font-size:11px;color:var(--lm-muted);white-space:nowrap}
.lm-empty{background:#fff;padding:40px 16px;text-align:center;color:var(--lm-muted)}
`;

/* 分頁 */
const PAGER = `
.lm-pager{display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;padding:24px 0 40px}
.lm-pager a,.lm-pager span{
  min-width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
  padding:0 10px;border-radius:var(--lm-radius);font-size:14px;color:#555;background:rgba(0,0,0,.03);
}
.lm-pager a:hover{background:#fff;box-shadow:var(--lm-shadow)}
.lm-pager .lm-page-current{background:var(--lm-brand);color:#fff}
.lm-pager .lm-page-info{background:none;color:var(--lm-muted);font-size:13px}
`;

/* 商品頁：左圖右購買區（規格 §4.2） */
const PRODUCT = `
.lm-crumb{font-size:13px;color:var(--lm-muted);padding:14px 0}
.lm-crumb a:hover{color:var(--lm-brand)}
.lm-crumb span{margin:0 6px;opacity:.6}

.lm-product{
  background:var(--lm-card);box-shadow:var(--lm-shadow);
  display:grid;gap:0;grid-template-columns:minmax(0,1fr);
}
@media(min-width:900px){
  .lm-product{grid-template-columns:minmax(0,440px) minmax(0,1fr)}
}
.lm-gallery{padding:16px}
.lm-gallery-main{
  aspect-ratio:1/1;background:#fafafa;overflow:hidden;
  border:1px solid var(--lm-line);
}
.lm-gallery-main img{width:100%;height:100%;object-fit:cover;object-position:top center}
.lm-gallery-strip{display:flex;gap:8px;margin-top:10px;overflow-x:auto}
.lm-gallery-strip button{
  flex:0 0 auto;width:62px;height:62px;border:1px solid var(--lm-line);
  background:#fafafa;padding:0;overflow:hidden;
}
.lm-gallery-strip button[aria-current="true"]{border-color:var(--lm-brand)}
.lm-gallery-strip img{width:100%;height:100%;object-fit:cover}

.lm-buy{padding:20px 24px 24px;display:flex;flex-direction:column;gap:16px;min-width:0}
.lm-buy h1{font-size:20px;line-height:1.4;margin:0;font-weight:400}
.lm-stats-row{display:flex;align-items:center;gap:14px;font-size:13px;color:var(--lm-muted);flex-wrap:wrap}
.lm-stats-row b{color:var(--lm-brand);border-bottom:1px solid var(--lm-brand);font-weight:400}
.lm-price-block{background:#fafafa;padding:14px 16px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.lm-price-block .lm-price{font-size:30px}
.lm-price-block .lm-price-was{font-size:15px}
.lm-save{background:var(--lm-brand);color:#fff;font-size:11px;padding:2px 5px;font-weight:700}

.lm-field{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.lm-field>h2{
  flex:0 0 78px;font-size:13px;color:var(--lm-muted);margin:7px 0 0;font-weight:400;
}
.lm-field-body{flex:1 1 220px;min-width:0;display:flex;flex-wrap:wrap;gap:8px}
.lm-plan{
  border:1px solid var(--lm-line);background:#fff;padding:8px 12px;
  text-align:left;min-width:132px;position:relative;
}
.lm-plan:hover{border-color:var(--lm-brand);color:var(--lm-brand)}
.lm-plan[aria-pressed="true"]{border-color:var(--lm-brand);color:var(--lm-brand);background:var(--lm-brand-soft)}
.lm-plan b{display:block;font-size:13px;font-weight:500}
.lm-plan small{display:block;font-size:11px;color:var(--lm-muted);margin-top:2px}
.lm-plan[aria-pressed="true"] small{color:var(--lm-brand)}

.lm-qty{display:flex;align-items:center;gap:0;border:1px solid var(--lm-line)}
.lm-qty button{width:32px;height:32px;font-size:16px;color:#555}
.lm-qty button:hover{background:#fafafa}
.lm-qty output{width:50px;text-align:center;font-size:14px;border-left:1px solid var(--lm-line);border-right:1px solid var(--lm-line);line-height:32px}

.lm-actions{display:flex;gap:12px;flex-wrap:wrap;padding-top:4px}
.lm-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:0 20px;height:48px;border-radius:var(--lm-radius);font-size:15px;
}
.lm-btn-ghost{background:var(--lm-brand-soft);color:var(--lm-brand);border:1px solid var(--lm-brand)}
.lm-btn-ghost:hover{background:#ffe9e2}
.lm-btn-solid{background:var(--lm-brand);color:#fff}
.lm-btn-solid:hover{background:var(--lm-brand-dark)}
.lm-btn-flat{background:#fff;color:#555;border:1px solid var(--lm-line);height:40px;font-size:14px}
.lm-btn-flat:hover{border-color:var(--lm-brand);color:var(--lm-brand)}
.lm-note{font-size:12px;color:var(--lm-muted);margin:0}

/* 店家資訊列 */
.lm-shop{
  background:var(--lm-card);box-shadow:var(--lm-shadow);margin-top:16px;
  padding:20px 24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap;
}
.lm-shop-avatar{
  width:56px;height:56px;border-radius:50%;background:var(--lm-brand);
  color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:22px;font-weight:700;flex:0 0 auto;
}
.lm-shop-main{flex:1 1 200px;min-width:0}
.lm-shop-main b{display:block;font-size:16px;font-weight:500}
.lm-shop-main p{margin:3px 0 0;font-size:12px;color:var(--lm-muted)}
.lm-shop-metrics{display:flex;gap:28px;flex-wrap:wrap}
.lm-shop-metrics div{font-size:12px;color:var(--lm-muted)}
.lm-shop-metrics b{display:block;color:var(--lm-brand);font-size:15px;font-weight:400}

/* 下方：描述與規格表 */
.lm-panel{background:var(--lm-card);box-shadow:var(--lm-shadow);margin-top:16px}
.lm-panel>h2{
  margin:0;padding:14px 20px;background:rgba(0,0,0,.02);
  font-size:15px;font-weight:400;text-transform:uppercase;letter-spacing:.3px;color:#555;
}
.lm-panel-body{padding:20px}
.lm-desc{font-size:14px;line-height:1.9;color:#333;white-space:pre-wrap;margin:0;overflow-wrap:break-word}
.lm-specs{width:100%;border-collapse:collapse;font-size:14px}
.lm-specs th,.lm-specs td{text-align:left;padding:8px 10px;vertical-align:top}
.lm-specs th{color:var(--lm-muted);font-weight:400;width:140px;white-space:nowrap}
.lm-specs tr+tr th,.lm-specs tr+tr td{border-top:1px solid var(--lm-line)}
.lm-tags{display:flex;gap:6px;flex-wrap:wrap}
.lm-tag{border:1px solid var(--lm-line);padding:2px 9px;font-size:12px;color:#555;border-radius:var(--lm-radius)}
.lm-tag:hover{border-color:var(--lm-brand);color:var(--lm-brand)}
.lm-scroll-x{overflow-x:auto}
`;

/* 方案面板（下載閘門）—— 一個真的 <dialog>，不是貼在頁面上的浮動層 */
const DIALOG = `
.lm-dialog{
  border:0;border-radius:4px;padding:0;max-width:440px;width:calc(100% - 32px);
  box-shadow:0 10px 40px rgba(0,0,0,.3);color:var(--lm-ink);
}
.lm-dialog::backdrop{background:rgba(0,0,0,.55)}
.lm-dialog-head{background:var(--lm-brand);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.lm-dialog-head b{font-size:16px;font-weight:500}
.lm-dialog-head button{color:#fff;font-size:20px;line-height:1;padding:0 4px}
.lm-dialog-body{padding:18px 20px 20px;display:flex;flex-direction:column;gap:12px}
.lm-dialog-body p{margin:0;font-size:13px;color:var(--lm-muted);line-height:1.7}
.lm-dialog-plans{display:flex;flex-direction:column;gap:8px}
.lm-dialog-plans button{
  border:1px solid var(--lm-line);padding:11px 14px;text-align:left;
  display:flex;justify-content:space-between;align-items:center;gap:12px;background:#fff;
}
.lm-dialog-plans button:hover{border-color:var(--lm-brand);background:var(--lm-brand-soft)}
.lm-dialog-plans b{font-weight:500}
.lm-dialog-plans small{display:block;color:var(--lm-muted);font-size:11px;margin-top:2px}
.lm-dialog-plans em{font-style:normal;color:var(--lm-brand);font-size:16px;white-space:nowrap}
`;

const TOAST = `
.lm-toast{
  position:fixed;left:50%;bottom:32px;transform:translateX(-50%);
  background:rgba(0,0,0,.82);color:#fff;padding:12px 20px;border-radius:3px;
  font-size:14px;z-index:60;max-width:calc(100% - 32px);text-align:center;
}
`;

const FOOTER = `
.lm-foot{
  background:var(--lm-card);border-top:4px solid var(--lm-brand);
  margin-top:28px;padding:26px 0;color:var(--lm-muted);font-size:12px;line-height:1.9;
}
.lm-foot b{display:block;color:#555;font-size:13px;margin-bottom:4px;font-weight:500}
.lm-foot-cols{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
`;

const THEME_CSS = [TOKENS, BASE, HEADER, CATEGORIES, GRID, PAGER, PRODUCT, DIALOG, TOAST, FOOTER]
  .join('')
  // 送出去的是一份靜態檔，縮一下沒壞處（註解已經在 JS 這邊了）
  .replace(/\n\s*/g, '')
  .trim();

module.exports = { THEME_CSS };
