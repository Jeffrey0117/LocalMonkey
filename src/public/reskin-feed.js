/*
 * 列表頁的無限載入（SPEC-reskin-v2 §7）。
 *
 * ⛔ 這支跑在**被代理的網站**上，紀律跟 `gm-shim.js` / `reskin-shop.js` 一樣：
 * 自己吞掉所有錯誤。沒有 `IntersectionObserver`、沒有 `fetch`、JS 整個沒跑起來
 * —— 任何一種情形都要留下那條 `<noscript>` 的真連結當退路（版型已經畫好了），
 * 絕對不准把頁面弄成「卡在載入中」。
 *
 * ⛔ **卡片的 HTML 是伺服器端畫的**（`/__lm/reskin/listing` 回 `html`），
 * 這裡只負責插進去。兩邊各畫一份的話，同一張卡會有兩個版本（地雷 62）。
 * 所以這支裡面沒有任何「卡片長什麼樣」的知識。
 *
 * 由 `/__lm/reskin/feed.js` 送出去，只有列表頁會載。
 */

(function () {
  var ENDPOINT = '/__lm/reskin/listing';
  /** 連續幾頁都是重複的就收手（見 appendCards 的去重） */
  var MAX_EMPTY_PAGES = 3;
  /** 一次只飛一個請求，而且往下滑太快也不要排隊 */
  var state = {
    busy: false,
    done: false,
    next: null,
    siteId: null,
    page: null,
    totalPages: null,
    empty: 0,
  };

  function byAttr(name) {
    return document.querySelector('[' + name + ']');
  }

  function statusNode() {
    return byAttr('data-lm-feed-status');
  }

  function retryNode() {
    return byAttr('data-lm-feed-retry');
  }

  /** 狀態列是 `role="status"`，所以改文字就等於對螢幕閱讀器播報 */
  function say(text, options) {
    var node = statusNode();
    if (!node) return;

    node.textContent = '';
    if (options && options.spinner) {
      var spin = document.createElement('span');
      spin.className = 'lm-feed-spin';
      node.appendChild(spin);
    }
    node.appendChild(document.createTextNode(text));
  }

  function showRetry(show) {
    var node = retryNode();
    if (node) node.hidden = !show;
  }

  function paintPage() {
    var node = byAttr('data-lm-feed-page');
    if (!node || state.page === null) return;

    node.textContent =
      state.totalPages === null
        ? '第 ' + state.page + ' 頁'
        : '第 ' + state.page + ' / ' + state.totalPages + ' 頁';
  }

  /**
   * ⛔ 網址列要跟著走（規格 §7）：使用者滑到第 3 頁按重新整理，應該還在第 3 頁
   * 附近，而不是被丟回第一頁。用 `replaceState` 而不是 `pushState` ——
   * 滑過五頁之後按上一頁應該回到**上一個頁面**，不是倒帶五次。
   */
  function rememberUrl(path) {
    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', path);
      }
    } catch (error) {
      console.warn('[LocalMonkey] 網址更新不了（不影響載入）', error);
    }
  }

  /**
   * 插進網格。
   *
   * ⛔ **照網址去重。** 上游的「首頁」與「第 1 頁」重疊是常態（實測：首頁是
   * 精選 12 件，而第 1 頁的前 12 件就是同一批），所以第一次載入一定會拿到
   * 已經在畫面上的卡片。身分用卡片自己的 `href` —— 它是伺服器端畫進 DOM 的，
   * 所以這裡不需要知道「卡片長什麼樣」。
   *
   * @returns {number} 真的新增了幾張
   */
  function appendCards(html) {
    var grid = byAttr('data-lm-grid');
    if (!grid || typeof html !== 'string' || html.length === 0) return 0;

    var seen = {};
    Array.prototype.forEach.call(grid.querySelectorAll('[href]'), function (node) {
      seen[node.getAttribute('href')] = true;
    });

    var holder = document.createElement('div');
    holder.innerHTML = html;

    var added = 0;
    var incoming = Array.prototype.slice.call(holder.children);

    for (var index = 0; index < incoming.length; index += 1) {
      var card = incoming[index];
      var href = card.getAttribute ? card.getAttribute('href') : null;

      if (href !== null && seen[href]) continue;
      if (href !== null) seen[href] = true;

      grid.appendChild(card);
      added += 1;
    }

    return added;
  }

  /** DOM 上的 `data-lm-next` 要跟著走，不然留在頁面上的是第一次那個舊值 */
  function rememberNext(path) {
    var tail = byAttr('data-lm-feed');
    if (!tail) return;

    if (path === null) tail.removeAttribute('data-lm-next');
    else tail.setAttribute('data-lm-next', path);
  }

  function finish(text) {
    state.done = true;
    state.next = null;
    rememberNext(null);
    say(text);
    showRetry(false);
  }

  function load() {
    if (state.busy || state.done || state.next === null) return;

    state.busy = true;
    showRetry(false);
    say('載入下一頁…', { spinner: true });

    var wanted = state.next;
    var url =
      ENDPOINT + '?site=' + encodeURIComponent(state.siteId) + '&path=' + encodeURIComponent(wanted);

    window
      .fetch(url, { headers: { accept: 'application/json' }, credentials: 'omit' })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        state.busy = false;

        if (result.status !== 200 || !result.payload || result.payload.ok !== true) {
          // 伺服器說「這一頁沒有更多了」跟「失敗了」要分開：前者是結束，
          // 後者要讓使用者能重試（規格 §7：失敗要有重試）
          if (result.payload && result.payload.reason === 'no-match') {
            finish('已經到底了');
            return;
          }
          say('這一頁載入失敗了。');
          showRetry(true);
          return;
        }

        var payload = result.payload;
        var added = appendCards(payload.html);

        if (typeof payload.page === 'number') state.page = payload.page;
        if (typeof payload.totalPages === 'number') state.totalPages = payload.totalPages;
        paintPage();
        rememberUrl(wanted);

        state.next =
          typeof payload.nextPath === 'string' && payload.nextPath.length > 0
            ? payload.nextPath
            : null;
        rememberNext(state.next);

        if (state.next === null) {
          finish('已經到底了');
          return;
        }

        /**
         * ⛔ 「一張新卡都沒有」**不等於**「沒有更多」——第一次載入常常整頁都是
         * 重複的（首頁與第 1 頁重疊）。所以一張都沒新增就直接抓下一頁，
         * 但連續幾次都這樣就收手（不然上游給一串重複頁會變成無限抓）。
         */
        if (added === 0) {
          state.empty += 1;
          if (state.empty >= MAX_EMPTY_PAGES) {
            finish('已經到底了');
            return;
          }
          load();
          return;
        }

        state.empty = 0;
        say('往下滑看更多');
        watch();
      })
      .catch(function (error) {
        state.busy = false;
        console.warn('[LocalMonkey] 下一頁載入失敗', error);
        say('這一頁載入失敗了。');
        showRetry(true);
      });
  }

  var observer = null;

  /**
   * 觀察那塊尾巴。
   *
   * `rootMargin` 讓它在距離底部還有一屏的時候就開始抓 —— 滑到底才抓的話
   * 使用者一定會看到一次停頓。
   */
  function watch() {
    var tail = byAttr('data-lm-feed');
    if (!tail || observer === null) return;

    observer.unobserve(tail);
    if (!state.done && state.next !== null) observer.observe(tail);
  }

  function start() {
    var tail = byAttr('data-lm-feed');
    if (!tail) return; // 商品頁；或這一頁沒有列表

    var shopConfig = document.querySelector('[data-lm-shop-config]');
    try {
      state.siteId = shopConfig ? JSON.parse(shopConfig.textContent).siteId : null;
    } catch (error) {
      state.siteId = null;
    }

    state.next = tail.getAttribute('data-lm-next');
    if (!state.next || !state.siteId) return; // 已經到底了（伺服器端已經寫好那句話）

    var pageNode = byAttr('data-lm-feed-page');
    var matched = pageNode ? /(\d+)(?:\s*\/\s*(\d+))?/.exec(pageNode.textContent) : null;
    if (matched) {
      state.page = Number(matched[1]);
      state.totalPages = matched[2] ? Number(matched[2]) : null;
    }

    var canObserve = typeof window.IntersectionObserver === 'function';
    var canFetch = typeof window.fetch === 'function';

    if (!canFetch) return; // `<noscript>` 的連結還在，那就是退路

    var retry = retryNode();
    if (retry) {
      retry.addEventListener('click', function () {
        load();
      });
    }

    if (!canObserve) {
      // 舊瀏覽器：退回「按一下載入下一頁」，而不是整個功能消失
      if (retry) retry.textContent = '載入下一頁';
      say('這個瀏覽器不會自動載入，用下面的按鈕看下一頁。');
      showRetry(true);
      return;
    }

    say('往下滑看更多');
    observer = new window.IntersectionObserver(
      function (entries) {
        for (var index = 0; index < entries.length; index += 1) {
          if (entries[index].isIntersecting) load();
        }
      },
      { rootMargin: '600px 0px' },
    );
    watch();
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  } catch (error) {
    console.warn('[LocalMonkey] 無限載入沒啟動起來（頁面照常）', error);
  }
})();
