// ==UserScript==
// @name         AutoReel IG 留言關鍵字抓取
// @namespace    autoreel
// @version      1.0.0
// @description  在 IG 貼文/Reel 頁:載入全部留言 → 掃出「留言含關鍵字」的帳號 → 去重 → 一鍵存進批量私訊腳本的名單。⚠️ 建議抓自己貼文、配合 comment→DM 漏斗用,別騷擾陌生人。
// @author       AutoReel
// @match        https://www.instagram.com/*
// @grant        none
// ==/UserScript==

/*
 * 這是 fixture：只保留 header 區塊。
 * 原始檔 203 行，來源 C:/Users/AUSER/code/AutoReel/scripts/ig-comment-scraper.user.js
 * 唯讀參考，不要改這裡的 header —— 它的價值就在於是真的。
 */
