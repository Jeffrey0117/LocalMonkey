// ==UserScript==
// @name         Reelo Threads Helper
// @namespace    https://reelo.local/
// @version      1.1.2
// @description  自動接 Reelo backend job → 在 threads.net 發純文字貼文
// @match        https://www.threads.com/*
// @match        https://www.threads.net/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/*
 * 這是 fixture：只保留 header 區塊。
 * 原始檔 485 行，來源 C:/Users/AUSER/code/AutoReel/scripts/threads-helper.user.js
 * 唯讀參考，不要改這裡的 header —— 它的價值就在於是真的。
 */
