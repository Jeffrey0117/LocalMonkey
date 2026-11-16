// ==UserScript==
// @name         XCard - X/Threads → Reelo (PNG + 送進 Reelo 圖卡草稿)
// @namespace    autoreel-xpost
// @version      1.3.7
// @description  X/Threads 貼文一鍵翻譯成中文 PNG 圖卡 + 直接送進 Reelo 圖卡草稿庫排程發 IG
// @author       AutoReel (fork of XCard by Jeffrey0117)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://www.threads.com/*
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      translate.googleapis.com
// @connect      pbs.twimg.com
// @connect      fbcdn.net
// @connect      cdninstagram.com
// @connect      localhost
// @updateURL    http://localhost:8001/scripts/xpost-card.user.js
// @downloadURL  http://localhost:8001/scripts/xpost-card.user.js
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js
// ==/UserScript==

/*
 * 這是 fixture：只保留 header 區塊。
 * 原始檔 1205 行，來源 C:/Users/AUSER/code/AutoReel/scripts/xpost-card.user.js
 * 唯讀參考，不要改這裡的 header —— 它的價值就在於是真的。
 */
