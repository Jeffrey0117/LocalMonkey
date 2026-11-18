'use strict';

const { filterResponseHeaders } = require('../lib/headers.js');
const { rewriteSetCookie } = require('../lib/cookies.js');
const { rewriteLocation } = require('../lib/location.js');
const { rewriteDocumentUrls, injectScripts } = require('../lib/html.js');
const { withHtmlCachePolicy, withDevModeCachePolicy } = require('../lib/cache-policy.js');
const { bustCacheReferences } = require('../lib/cache-bust.js');
const { planInjection } = require('../lib/injection.js');
const { SITE_COOKIE_NAME } = require('../lib/site-resolve.js');

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function isHtmlResponse(contentType) {
  return typeof contentType === 'string' && HTML_CONTENT_TYPE.test(contentType);
}

function pathnameOf(pathWithQuery) {
  const index = pathWithQuery.search(/[?#]/);
  return index === -1 ? pathWithQuery : pathWithQuery.slice(0, index);
}

/**
 * 挑出這個頁面要注入的東西：啟用中、path_glob 對得上、沒被 @exclude 排除，
 * 再照 run_at 分成三個注入位置（headStart / head / body）。
 * 真正的規則在 lib/injection.js。
 */
function selectScripts(store, site, pathname) {
  return planInjection(store.userscripts.listForInjection(site.id), { pathname });
}

/**
 * HTML 改寫一律走 latin1。latin1 ↔ Buffer 是 byte-lossless，
 * 所以不管頁面是 UTF-8、Big5 還是什麼，沒被我們改到的 byte 都原封不動。
 *
 * 改寫要吃 `target_origin`（不只 siteId）—— `<base href>` 與 meta refresh
 * 的值可能是絕對網址，得先判斷它指的是不是這個站。
 *
 * **順序是規格的一部分**：
 *   0. 重繪（v8，SPEC-reskin §5）—— **在最前面，而且會取代第 1 步**：
 *      它把上游當**資料來源**，整份文件是我們重畫的，所以沒有「上游的網址」
 *      需要改寫（抽取層已經把網址換成代理路徑了，見 `reskin/url.js`）。
 *      回 `null` ＝ 這一頁不重繪，照舊走下面的第 1 步
 *   1. 網址改寫（`lib/html.js`）
 *   2. 翻譯回填（v4）—— 要在網址改寫**之後**：切段器算的是座標，
 *      任何之後發生的字串改動都會讓那些座標失效
 *   3. 改造規則（v5）—— 文字規則套在**翻譯後**的文字上（SPEC-rules §1），
 *      所以 `templatemo → templatee` 不會被翻譯快取汙染；hide 的 CSS 插在
 *      `</head>` 之前
 *   4. 資源覆寫的 cache busting（v6）—— 要在 1~3 **之後**：它改的是屬性值，
 *      而切段器算的是字元座標。放前面的話座標全部失效（版面爆開，而 curl
 *      看起來一切正常）
 *   5. 腳本注入 —— 只在頭尾加 tag，不影響前面四步
 *
 * 2~5 在重繪模式下**照舊全部跑**（規格 §5 的對照表）：第 2 步翻我們抽出來的
 * 品名與描述、第 3 步的選擇器對的是我們自己的 class、第 5 步的 userscript
 * 照樣注入。差別只有「第 1 步的輸入是誰」。
 *
 * 重繪層、翻譯層與規則層都是同步的、只查 SQLite；壞掉就回原字串
 * （見 reskin/service.js、translate/service.js 與 rules/service.js）。
 */
function transformHtml(buffer, {
  site,
  scripts,
  reskin,
  translate,
  rules,
  versions,
  contentType,
  pathWithQuery,
  onStats,
}) {
  const source = buffer.toString('latin1');

  const reskinned = reskin
    ? reskin(source, { site, pathWithQuery, contentType, onStats: onStats?.reskin })
    : null;

  const rewritten =
    reskinned ??
    rewriteDocumentUrls(source, {
      siteId: site.id,
      targetOrigin: site.target_origin,
    });

  const translated = translate
    ? translate(rewritten, { site, contentType, onStats: onStats?.translate })
    : rewritten;

  const ruled = rules
    ? rules(translated, { site, contentType, onStats: onStats?.rules })
    : translated;

  const busted = bustCacheReferences(ruled, { siteId: site.id, versions });

  return Buffer.from(injectScripts(busted, scripts), 'latin1');
}

/**
 * HTML 的 header 要多做一件事：拿掉上游的快取指示、改成 no-store
 * （理由在 lib/cache-policy.js —— 我們回的 HTML 是改造過的，不是上游那份）。
 * 非 HTML 原樣轉述，那是效能的來源。
 *
 * **開發模式**（`sites.dev_mode`，SPEC-rules §8.2）例外：非 HTML 也改成
 * `no-cache`（保留 ETag → 304 不傳 body）。那是「只被外部 CSS 檔的 url()
 * 引用的資源拿不到 `?v=`」這個邊界的解法。
 */
function cachePolicyFor(pairs, { html, devMode }) {
  if (html) return withHtmlCachePolicy(pairs);
  return devMode ? withDevModeCachePolicy(pairs) : pairs;
}

function copyHeaders(res, response, site, { html }) {
  const filtered = filterResponseHeaders(response.headers);
  const pairs = cachePolicyFor(filtered, { html, devMode: site.dev_mode === true });

  for (const [name, value] of pairs) {
    res.setHeader(name, name === 'location' ? rewriteLocation(value, site) : value);
  }

  for (const cookie of response.headers.getSetCookie()) {
    const rewritten = rewriteSetCookie(cookie);
    if (rewritten) res.append('set-cookie', rewritten);
  }
}

/**
 * 兩個給人除錯用的 header（SPEC-rules §5.2）。
 *
 * 「怎麼這邊沒翻譯到」是使用者最常問的一句，而伺服器端看到的東西（快取命中
 * 幾段）在瀏覽器裡完全看不出來。`x-lm-translate: 12/85` 就是那個答案。
 *
 * 要在 `res.end()` **之前**設好，所以 body 先組好再送。
 */
function setDebugHeaders(res, stats) {
  /**
   * 重繪的那一行是**三個問題的答案**：這一頁重繪了嗎、抽到幾項、
   * 沒重繪的話是為什麼。最後那個最重要 —— `reason=no-match` 與
   * `reason=extract-failed` 看起來一樣（都是「頁面長得跟原本一樣」），
   * 但一個是正常的、一個是設定壞了。
   */
  if (stats.reskin) {
    const { mode } = stats.reskin;
    res.setHeader(
      'x-lm-reskin',
      mode === 'reskin'
        ? `${stats.reskin.theme} ${stats.reskin.kind} items=${stats.reskin.items}` +
            ` cache=${stats.reskin.cached ? 'hit' : 'miss'}`
        : `proxy reason=${stats.reskin.reason}`,
    );
  }
  if (stats.translate) {
    // `no-translate` 擋掉幾段只有有規則的站才附上 —— `hits/total` 的形狀是既有的
    // 契約（而且是人在看的），沒省到任何東西時不要在上面加噪音
    const skipped = stats.translate.noTranslate > 0 ? ` no-translate=${stats.translate.noTranslate}` : '';
    res.setHeader('x-lm-translate', `${stats.translate.hits}/${stats.translate.total}${skipped}`);
  }
  if (stats.rules) {
    // 「這個站有幾條 no-translate 在生效」跟「這一頁省了幾段」是兩個問題：
    // 規則有載到但這一頁一段都沒中時，前者才答得出「寫了沒反應」的原因
    const noTranslate = stats.rules.noTranslate > 0 ? ` no-translate=${stats.rules.noTranslate}` : '';
    res.setHeader(
      'x-lm-rules',
      `hide=${stats.rules.hide} css=${stats.rules.css ?? 0} text=${stats.rules.text}${noTranslate}`,
    );
  }
}

/**
 * @param {import('express').Response} res
 * @param {{
 *   site: object,
 *   response: Response,
 *   buffer: Buffer,
 *   pathWithQuery: string,
 *   store: object,
 *   translate?: (html: string, context: object) => string,
 *   rules?: (html: string, context: object) => string,
 * }} input
 */
function sendProxiedResponse(res, {
  site,
  response,
  buffer,
  pathWithQuery,
  store,
  reskin,
  translate,
  rules,
}) {
  const contentType = response.headers.get('content-type');
  const html = isHtmlResponse(contentType);
  const hasBody = !BODYLESS_STATUSES.has(response.status) && buffer.length > 0;

  copyHeaders(res, response, site, { html });

  if (html) {
    // 根路徑 fallback 要靠這個 cookie 才知道 /assets/app.js 是誰的
    res.append('set-cookie', `${SITE_COOKIE_NAME}=${site.id}; Path=/; SameSite=Lax`);
  }

  res.status(response.status);

  if (!html || !hasBody) {
    res.end(buffer);
    return;
  }

  const scripts = selectScripts(store, site, pathnameOf(pathWithQuery));
  const stats = {};
  const body = transformHtml(buffer, {
    site,
    scripts,
    reskin,
    translate,
    rules,
    // 被覆寫的路徑 → 版本號。大部分站是空的 Map，bustCacheReferences 會直接跳過。
    versions: store.resourceOverrides.versions(site.id),
    contentType,
    pathWithQuery,
    onStats: {
      reskin: (value) => {
        stats.reskin = value;
      },
      translate: (value) => {
        stats.translate = value;
      },
      rules: (value) => {
        stats.rules = value;
      },
    },
  });

  setDebugHeaders(res, stats);
  res.end(body);
}

module.exports = {
  sendProxiedResponse,
  selectScripts,
  transformHtml,
  isHtmlResponse,
  pathnameOf,
  setDebugHeaders,
};
