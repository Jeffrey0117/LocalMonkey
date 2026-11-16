// ==UserScript==
// @name         AutoReel IG Helper
// @namespace    autoreel
// @version      1.13.6
// @description  Bridges AutoReel scheduler with Instagram DOM — injects video or multi-image carousel via File API (v1.7.9 base + 你 v1.8.x 觸發 IG 睡, 回 v1.7 鎖屏)
// @author       AutoReel
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      localhost
// @run-at       document-idle
// @noframes
// @updateURL    http://localhost:8001/scripts/ig-helper.user.js
// @downloadURL  http://localhost:8001/scripts/ig-helper.user.js
// ==/UserScript==

/*
 * 這是 fixture：只保留 header 區塊。
 * 原始檔 1337 行，來源 C:/Users/AUSER/code/AutoReel/scripts/ig-helper.user.js
 * 唯讀參考，不要改這裡的 header —— 它的價值就在於是真的。
 */
