'use strict';

/**
 * 重繪模式對代理的門面（SPEC-reskin §5）。
 *
 * ```
 * 上游 HTML → 抽資料 → 我們的版型渲染 → （之後照舊）翻譯 → 規則 → 送出
 * ```
 *
 * ⛔ **回 `null` ＝ 退回代理模式。** 這是整支最重要的契約（規格 §7.2）：
 * 沒開重繪、沒有設定命中、charset 不對、抽不到東西、甚至我們自己炸了 ——
 * 全部回 `null`，呼叫端就走原本那條「改寫上游 HTML」的路。
 * `/about`、`/contact` 這種沒設定的頁面因此照舊能開，而且**一行特例都不用寫**。
 *
 * ⛔ 跟翻譯層與規則層同一套紀律：**同步**，而且只查 SQLite。
 * 一旦它能 await，就一定有人會在請求路徑上做網路 IO。
 *
 * ⛔ **編碼的邊界就在這裡。** 代理的 HTML 管線全程走 latin1（byte-lossless，
 * 所以不用猜頁面編碼）。抽取要讀懂文字、版型要寫出中文，所以這支在入口
 * `fromLatin1`、出口 `toLatin1`，中間全部是真文字 —— 跟翻譯層一模一樣的做法
 * （`translate/bytes.js` 有完整說明）。
 */

const { compileConfig, findEntry } = require('./config.js');
const { compilePricing } = require('./pricing.js');
const { extractData, DATA_MODEL_VERSION } = require('./extract.js');
const { themeFor, DEFAULT_THEME } = require('./themes/index.js');
const { DEFAULT_ENV, paymentTone } = require('./newebpay.js');
const { sha256 } = require('../db/reskin.js');
const { isUtf8Document } = require('../translate/charset.js');
const { fromLatin1, toLatin1 } = require('../translate/bytes.js');
const { proxyPrefix } = require('../lib/proxy-path.js');

/** 抽取是純 CPU 的，但壞掉的頁面可以很大 —— 這是「別把請求拖死」的防線 */
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function pathnameOf(pathWithQuery) {
  const index = String(pathWithQuery ?? '/').search(/[?#]/);
  return index === -1 ? String(pathWithQuery ?? '/') : String(pathWithQuery).slice(0, index);
}

/** 版型的「回首頁」連結。版型層不知道上游是誰，所以路徑由這裡給。 */
function homeFor(siteId) {
  return `${proxyPrefix(siteId)}/`;
}

/**
 * @param {{
 *   store: object,
 *   logger: object,
 *   payments?: { connected: boolean, env?: 'test'|'live', missing?: Array<string> },
 * }} context
 *   `payments` 是「這台機器有沒有接金流」（SPEC-checkout §1）。
 *   預設沒接 ＝ 示範模式，版型會據此改文案與結帳面板。
 */
function createReskinService({
  store,
  logger,
  payments = { connected: false, env: DEFAULT_ENV, missing: [] },
}) {
  /**
   * 每個請求重新讀 + 重新編譯（同規則層）。看起來浪費，但是刻意的：
   * 設定通常兩三筆，一次 index 命中的 SELECT 加幾個正則編譯是微秒級；
   * 而快取 `RegExp` 物件會帶著 `lastIndex` 跨請求活著，那種 bug 只在
   * 高併發下現形。「改了設定立刻生效」也是這樣來的。
   */
  function settingsFor(site) {
    return {
      config: compileConfig(site.reskin_config),
      pricing: compilePricing(site.reskin_pricing),
      theme: themeFor(site.reskin_theme ?? DEFAULT_THEME),
    };
  }

  /**
   * 版型拿得到的東西。
   *
   * ⛔ **只有這裡決定版型看得到什麼。** 版型層不碰 DB、不認識上游，所以
   * 「回首頁的路徑」「價格方案」「金流接了沒」都得由這支餵進去。
   *
   * ⛔ 金流**只給兩個值**：`connected`（設定齊全、按鈕是真的）與 `env`
   * （`test` / `live`）。商家金鑰、端點網址一個字都不准進頁面。
   * `env` 非得進去不可是因為規格 §1：`live` 的時候購買列要顯示警告色的
   * 「正式環境（會真的扣款）」—— 使用者按下去之前必須看得到。
   */
  function renderContextFor(site, pricing) {
    return {
      siteId: site.id,
      home: homeFor(site.id),
      pricing: pricing.ok ? pricing.value : compilePricing(null).value,
      payments: paymentsForTheme(),
    };
  }

  /**
   * 版型與控制台看得到的那一份（刻意是一支函式：少一個「忘了過濾」的機會）。
   *
   * ⛔ `tone` 在**這裡**算完才交給版型。版型層自己把 `connected` 與 `env`
   * 組起來的話，那個三態判斷就會有好幾份 —— 而組錯的其中一種結果是
   * 「畫面寫測試環境、實際在正式環境扣款」。三態只准有一個真相來源。
   */
  function paymentsForTheme() {
    const connected = payments.connected === true;
    const env = payments.env === 'live' ? 'live' : DEFAULT_ENV;

    return { connected, env, tone: paymentTone({ connected, env }) };
  }

  /**
   * 抽資料（走快取）。
   *
   * ⛔ **抽取失敗不寫快取。** 寫了的話使用者改好設定還得先想辦法把那筆失敗的
   * 紀錄弄掉 —— 而「改了設定沒反應」是寫抽取規則最怕的症狀（規格 §6）。
   */
  function dataFor(site, { entry, html, pathname }) {
    const htmlSha256 = sha256(html);
    const key = store.reskinCache.key({
      siteId: site.id,
      path: pathname,
      htmlSha256,
      // ⛔ 資料模型的版本也要進 key，不然改完抽取層會拿到舊形狀的資料
      // 而 log 顯示 cache=hit（db/reskin.js 有完整理由）
      version: DATA_MODEL_VERSION,
    });

    const cached = store.reskinCache.get(key);
    if (cached) return { ok: true, data: cached.data, cached: true };

    const extracted = extractData(html, {
      entry,
      siteId: site.id,
      targetOrigin: site.target_origin,
      pathname,
    });

    if (!extracted.ok) return extracted;

    store.reskinCache.put({
      key,
      siteId: site.id,
      path: pathname,
      htmlSha256,
      kind: extracted.data.kind,
      data: extracted.data,
    });
    store.reskinCache.trim(site.id);

    return { ok: true, data: extracted.data, cached: false };
  }

  /**
   * 代理叫的就是這支。
   *
   * @param {string} html **latin1 管線字串**（呼叫端給的就是這個）
   * @param {{
   *   site: object,
   *   pathWithQuery: string,
   *   contentType: string|null,
   *   onStats?: (stats: object) => void,
   * }} input
   * @returns {string|null} 重繪後的 latin1 管線字串；`null` ＝ 退回代理模式
   */
  function reskinHtml(html, { site, pathWithQuery, contentType, onStats }) {
    if (site.reskin_enabled !== true) return null;

    const pathname = pathnameOf(pathWithQuery);
    const report = (stats) => onStats?.({ pathname, ...stats });

    try {
      if (html.length > MAX_HTML_BYTES) {
        report({ mode: 'proxy', reason: 'too-large' });
        return null;
      }

      /**
       * ⛔ 跟翻譯層與文字規則同一條邊界：**只有明確宣告 UTF-8 的文件才重繪**。
       * 版型的文案是中文，而中文的 byte 表示法跟頁面宣告的編碼綁在一起 ——
       * 把 UTF-8 的 byte 插進一份宣告 Big5 的頁面，使用者看到的是亂碼
       * （`translate/charset.js` 有完整理由）。
       */
      if (!isUtf8Document(html, contentType)) {
        report({ mode: 'proxy', reason: 'charset' });
        return null;
      }

      const { config, pricing, theme } = settingsFor(site);

      if (!config.ok) {
        // 設定編不過是使用者改得動的問題，所以要大聲（規格 §3.2）：
        // 靜默退回代理模式會讓人以為「設定沒存到」。
        logger.warn(`${site.id} 的重繪設定編不過，這一頁退回代理模式：${config.error}`);
        report({ mode: 'proxy', reason: 'bad-config', error: config.error });
        return null;
      }
      if (config.value.length === 0) {
        report({ mode: 'proxy', reason: 'no-config' });
        return null;
      }

      const entry = findEntry(config.value, pathname);
      if (entry === null) {
        // 這是**正常**的：`/about` 這類頁面本來就該走代理（規格 §3.1 最後一條）
        report({ mode: 'proxy', reason: 'no-match' });
        return null;
      }

      const extracted = dataFor(site, { entry, html: fromLatin1(html), pathname });
      if (!extracted.ok) {
        logger.warn(`${site.id} ${pathname} 抽取失敗，退回代理模式：${extracted.reason}`);
        report({ mode: 'proxy', reason: 'extract-failed', error: extracted.reason, kind: entry.kind });
        return null;
      }

      const rendered = theme.render(extracted.data, renderContextFor(site, pricing));

      report({
        mode: 'reskin',
        kind: extracted.data.kind,
        theme: theme.ID,
        items: extracted.data.kind === 'listing' ? extracted.data.items.length : 1,
        cached: extracted.cached,
        pricingError: pricing.ok ? null : pricing.error,
      });

      return toLatin1(rendered);
    } catch (error) {
      // 重繪是加值功能，不准讓頁面開不起來（規格 §7.2）
      logger.error(`重繪 ${site.id} ${pathname} 時出錯，已退回代理模式`, error);
      report({ mode: 'proxy', reason: 'error', error: error.message });
      return null;
    }
  }

  /**
   * 無限載入的下一頁（SPEC-reskin-v2 §7）。
   *
   * ⛔ 吃的是**真文字**（呼叫端自己抓了一份上游頁面），回的是**卡片的 HTML
   * 片段**而不是純資料 —— 卡片的 markup 只能有一份。端點回 JSON 讓前端自己
   * 畫的話，同一張卡會有伺服器端與瀏覽器端兩個版本，而這個專案已經踩過
   * 「同一個值兩邊各算一次 → 畫面自己跳」（地雷 62）。
   * 所以 JSON 的欄位是「這一批的 HTML + 分頁資訊」。
   *
   * ⛔ 走的是**同一份快取**（`dataFor`）：使用者滑一次首頁就抓過第 2 頁，
   * 重新整理再滑的時候上游沒變就不用再抽一次。
   *
   * `listing` 以外的 kind 一律拒絕：第 2 頁不可能是一個商品頁，
   * 而「命中了但不是列表」是設定寫錯，前端要看到「沒有更多」而不是一直轉。
   */
  function nextPage(html, { site, pathname, contentType }) {
    if (site.reskin_enabled !== true) return { ok: false, reason: 'disabled' };
    if (!isUtf8Document(html, contentType)) return { ok: false, reason: 'charset' };

    const { config, pricing, theme } = settingsFor(site);
    if (!config.ok) return { ok: false, reason: 'bad-config', error: config.error };
    if (config.value.length === 0) return { ok: false, reason: 'no-config' };

    const entry = findEntry(config.value, pathname);
    if (entry === null) return { ok: false, reason: 'no-match' };
    if (entry.kind !== 'listing') return { ok: false, reason: 'not-listing' };

    const extracted = dataFor(site, { entry, html, pathname });
    if (!extracted.ok) return { ok: false, reason: 'extract-failed', error: extracted.reason };

    const { data } = extracted;

    return {
      ok: true,
      html: theme.renderNextPage(data, renderContextFor(site, pricing)),
      items: data.items.length,
      page: data.page,
      totalPages: data.totalPages,
      nextPath: data.nextPath ?? null,
      cached: extracted.cached,
    };
  }

  /**
   * 控制台的「試一下」（規格 §6）。
   *
   * ⛔ 寫抽取規則最怕的是「寫了沒反應」，所以這支要回**數字與實際抽到的值**，
   * 而且連「哪一筆設定命中」「每個欄位抽到什麼」都要說。
   * 吃的是**真文字**（呼叫端自己從上游抓一份頁面），不是 latin1 管線字串。
   *
   * 刻意**不走快取**：試跑的語意是「用我現在這份設定重算一次」。
   */
  function dryRun(html, { site, path, contentType, config: override, pricing: overridePricing }) {
    const pathname = pathnameOf(path ?? '/');

    const config = compileConfig(override === undefined ? site.reskin_config : override);
    if (!config.ok) return { path: pathname, ok: false, reason: 'bad-config', error: config.error };

    const pricing = compilePricing(
      overridePricing === undefined ? site.reskin_pricing : overridePricing,
    );

    const base = {
      path: pathname,
      charset_ok: isUtf8Document(html, contentType),
      entries: config.value.length,
      pricing_error: pricing.ok ? null : pricing.error,
    };

    if (config.value.length === 0) {
      return { ...base, ok: false, reason: 'no-config' };
    }

    const index = config.value.findIndex((entry) => {
      entry.match.lastIndex = 0;
      return entry.match.test(pathname);
    });

    if (index === -1) return { ...base, ok: false, reason: 'no-match' };

    const entry = config.value[index];
    const extracted = extractData(html, {
      entry,
      siteId: site.id,
      targetOrigin: site.target_origin,
      pathname,
    });

    if (!extracted.ok) {
      return { ...base, ok: false, reason: 'extract-failed', error: extracted.reason, matched: index, kind: entry.kind };
    }

    const { data } = extracted;

    return {
      ...base,
      ok: true,
      matched: index,
      kind: data.kind,
      theme: themeFor(site.reskin_theme ?? DEFAULT_THEME).ID,
      // 列表頁回前三項就夠看出對不對了，全部回去會讓控制台的面板爆長
      items: data.kind === 'listing' ? data.items.length : 1,
      sample: data.kind === 'listing' ? data.items.slice(0, 3) : data,
      page: data.kind === 'listing' ? { page: data.page, totalPages: data.totalPages } : null,
      categories: (data.categories ?? []).length,
    };
  }

  /** 控制台要知道「這個站現在是什麼狀態」 */
  function statusFor(site) {
    const config = compileConfig(site.reskin_config);
    const pricing = compilePricing(site.reskin_pricing);

    return {
      enabled: site.reskin_enabled === true,
      /**
       * ⛔ 回「**實際會用到的**版型」而不是 DB 裡的字串。存在 DB 裡的值會比
       * 程式碼舊（版型改過名字），而 `themeFor` 本來就會把舊名字轉過去 ——
       * 這裡照抄 DB 的話，控制台的下拉選單會選不到任何一個選項，
       * 而畫面上明明已經是新版型了。
       */
      theme: themeFor(site.reskin_theme ?? DEFAULT_THEME).ID,
      entries: config.ok ? config.value.length : 0,
      config_error: config.ok ? null : config.error,
      pricing_error: pricing.ok ? null : pricing.error,
      pricing: pricing.ok ? pricing.value : compilePricing(null).value,
      cached: store.reskinCache.count(site.id),
      // 控制台要講得出「金流接了沒、哪個環境、缺哪個 env」（SPEC-checkout §1）
      payments: { ...paymentsForTheme(), missing: payments.missing ?? [] },
      orders: store.reskinOrders.count(site.id),
    };
  }

  return { reskinHtml, nextPage, dryRun, statusFor, settingsFor, paymentsForTheme };
}

module.exports = { createReskinService, pathnameOf, homeFor, MAX_HTML_BYTES };
