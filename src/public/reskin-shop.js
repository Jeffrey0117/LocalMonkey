/*
 * 重繪版型的瀏覽器端：購物車、圖庫、數量、結帳（SPEC-reskin §4.3、
 * SPEC-reskin-v2 §6 / §8）。
 *
 * ⛔ **沒接金流的時候，這裡完全不碰網路。** 購物車在 `localStorage`，
 * 「確認」只是記在這台瀏覽器裡。接了金流（伺服器端有 PayGate 的 env）之後，
 * 「立即購買」會走**我們自己的**端點 `/__lm/reskin/checkout` —— 金鑰與
 * PayGate 的網址只活在伺服器端，這支看不到也不需要看到。
 *
 * ⛔ 這支跑在**被代理的網站**上，所以紀律跟 `gm-shim.js` 一樣：
 * 每一塊都要自己吞掉錯誤。localStorage 被停用（無痕模式、第三方 cookie 設定）
 * 時整頁不准壞 —— 降級成「這次造訪有效」的記憶體狀態就好。
 *
 * 由 `/__lm/reskin/shop.js` 送出去，設定從同一頁的
 * `<script type="application/json" data-lm-shop-config>` 讀。
 */

(function () {
  var CART_KEY = 'lm.reskin.cart';
  var CHECKOUT_ENDPOINT = '/__lm/reskin/checkout';

  /* ------------------------- 存取層（絕不丟例外） ------------------------- */

  var memory = {};

  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? memory[key] ?? null : JSON.parse(raw);
    } catch (error) {
      console.warn('[LocalMonkey] 讀不到本機儲存，改用這次造訪的記憶體狀態', error);
      return memory[key] ?? null;
    }
  }

  function writeStore(key, value) {
    memory[key] = value;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('[LocalMonkey] 寫不進本機儲存，這次的變更只在這一頁有效', error);
    }
  }

  function config() {
    var tag = document.querySelector('[data-lm-shop-config]');
    var fallback = { currency: 'NT$', plans: [], item: null, payments: { live: false } };
    if (!tag) return fallback;

    try {
      return JSON.parse(tag.textContent);
    } catch (error) {
      console.warn('[LocalMonkey] 版型設定解析失敗', error);
      return fallback;
    }
  }

  /* ------------------------------- 小工具 ------------------------------- */

  function money(currency, amount) {
    return currency + Number(amount).toLocaleString('en-US');
  }

  function toast(message) {
    var existing = document.querySelector('.lm-toast');
    if (existing) existing.remove();

    var node = document.createElement('div');
    node.className = 'lm-toast';
    node.setAttribute('role', 'status');
    node.textContent = message;
    document.body.appendChild(node);

    window.setTimeout(function () {
      node.remove();
    }, 2600);
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  /* ------------------------------- 購物車 ------------------------------- */

  function cart() {
    var value = readStore(CART_KEY);
    return Array.isArray(value) ? value : [];
  }

  function cartCount(lines) {
    return lines.reduce(function (total, line) {
      return total + (Number(line.qty) || 0);
    }, 0);
  }

  function paintCart() {
    var count = cartCount(cart());
    each('[data-lm-cart-count]', function (node) {
      node.textContent = String(count);
    });
  }

  /**
   * 同一個商品 + 同一個方案 ＝ 同一行（加數量而不是長出第二行）。
   * 沒有 id 的時候用名稱當身分 —— 抽不到 id 不該讓購物車整個失效。
   */
  function addToCart(item, plan, qty) {
    var key = (item.id || item.name || '?') + '|' + plan.id;
    var lines = cart();
    var found = null;

    for (var index = 0; index < lines.length; index += 1) {
      if (lines[index].key === key) found = lines[index];
    }

    var next = found
      ? lines.map(function (line) {
          return line.key === key ? Object.assign({}, line, { qty: line.qty + qty }) : line;
        })
      : lines.concat([
          {
            key: key,
            id: item.id,
            name: item.name,
            image: item.image,
            plan: plan.name,
            price: plan.price,
            qty: qty,
          },
        ]);

    writeStore(CART_KEY, next);
    paintCart();
  }

  /* --------------------------- 結帳面板 --------------------------- */

  function dialog() {
    return document.querySelector('[data-lm-checkout]');
  }

  function openCheckout() {
    var node = dialog();
    if (!node) return false;

    showError(null);
    // 舊瀏覽器沒有 showModal：退回「直接顯示」而不是整個功能死掉
    if (typeof node.showModal === 'function') node.showModal();
    else node.setAttribute('open', '');

    var email = node.querySelector('[data-lm-email]');
    if (email && typeof email.focus === 'function') email.focus();

    return true;
  }

  function closeCheckout() {
    var node = dialog();
    if (!node) return;

    if (typeof node.close === 'function') node.close();
    else node.removeAttribute('open');
  }

  function showError(message) {
    var node = document.querySelector('[data-lm-checkout-error]');
    if (!node) return;

    node.textContent = message === null ? '' : message;
    node.hidden = message === null;
  }

  function goButton() {
    return document.querySelector('[data-lm-checkout-go]');
  }

  /**
   * 真的去結帳（只有伺服器端接了金流才會走到這裡）。
   *
   * ⛔ 失敗要**留在面板上**並說為什麼。導去一個壞掉的網址、或默默什麼都不做，
   * 都比一句「現在不能結帳」難查。
   */
  function checkout(settings) {
    var node = dialog();
    var emailInput = node ? node.querySelector('[data-lm-email]') : null;
    var email = emailInput ? String(emailInput.value || '').trim() : '';

    if (email.length === 0) {
      showError('請填 email，付款收據要寄到那裡。');
      if (emailInput) emailInput.focus();
      return;
    }

    var button = goButton();
    if (button) {
      button.disabled = true;
      button.textContent = '處理中…';
    }
    showError(null);

    window
      .fetch(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          site: settings.siteId,
          email: email,
          item: settings.item ? settings.item.name : null,
        }),
      })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        if (result.status === 200 && result.payload && result.payload.checkout_url) {
          window.location.href = result.payload.checkout_url;
          return;
        }

        restoreGo(settings);
        showError(
          (result.payload && result.payload.message) || '現在不能結帳，請稍後再試。',
        );
      })
      .catch(function (error) {
        console.warn('[LocalMonkey] 結帳失敗', error);
        restoreGo(settings);
        showError('連不到伺服器，請稍後再試。');
      });
  }

  function restoreGo(settings) {
    var button = goButton();
    if (!button) return;

    button.disabled = false;
    button.textContent = settings.payments && settings.payments.live ? '前往付款' : '確認';
  }

  /* ------------------------- 商品頁的方案與數量 ------------------------- */

  function selectedPlan(plans) {
    var pressed = document.querySelector('[data-lm-plan][aria-pressed="true"]');
    var id = pressed ? pressed.getAttribute('data-lm-plan') : null;

    var found = plans.filter(function (plan) {
      return plan.id === id;
    })[0];

    return found || plans[0] || { id: 'standard', name: '單檔購買', price: 0 };
  }

  function quantity() {
    var out = document.querySelector('[data-lm-qty-out]');
    var value = out ? Number.parseInt(out.textContent, 10) : 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function setQuantity(value) {
    var out = document.querySelector('[data-lm-qty-out]');
    if (out) out.textContent = String(Math.min(99, Math.max(1, value)));
  }

  function paintPrice(currency, plan) {
    var out = document.querySelector('[data-lm-price-out]');
    if (out) out.textContent = plan.price === 0 ? '不用錢' : money(currency, plan.price);
  }

  function pickPlan(button, currency, plans) {
    each('[data-lm-plan]', function (node) {
      node.setAttribute('aria-pressed', String(node === button));
    });
    paintPrice(currency, selectedPlan(plans));
  }

  /* ------------------------------- 接線 ------------------------------- */

  function start() {
    var settings = config();
    var plans = Array.isArray(settings.plans) ? settings.plans : [];
    var currency = settings.currency || 'NT$';
    var live = Boolean(settings.payments && settings.payments.live);

    paintCart();
    // 只有畫得出選擇區（兩檔以上）的時候才需要重畫價格；單一方案時
    // 伺服器端印的就是最終答案，碰它只會製造第二個真相來源（地雷 62）
    if (plans.length > 1) paintPrice(currency, selectedPlan(plans));

    document.addEventListener('click', function (event) {
      var target = event.target.closest
        ? event.target.closest(
            '[data-lm-plan],[data-lm-qty],[data-lm-buy],[data-lm-checkout-go],[data-lm-close],[data-lm-cart-open],[data-lm-follow],[data-lm-pick]',
          )
        : null;
      if (!target) return;

      /* 縮圖列 */
      var pick = target.getAttribute('data-lm-pick');
      if (pick !== null) {
        var main = document.querySelector('[data-lm-main]');
        if (main) main.setAttribute('src', pick);
        each('[data-lm-pick]', function (node) {
          node.setAttribute('aria-current', String(node === target));
        });
        return;
      }

      /* 方案與數量 */
      if (target.hasAttribute('data-lm-plan')) {
        pickPlan(target, currency, plans);
        return;
      }
      if (target.hasAttribute('data-lm-qty')) {
        setQuantity(quantity() + Number(target.getAttribute('data-lm-qty')));
        return;
      }

      /* 立即購買 ＝ 記進購物車 + 開結帳面板 */
      if (target.hasAttribute('data-lm-buy')) {
        if (!settings.item) return;

        addToCart(settings.item, selectedPlan(plans), quantity());
        if (!openCheckout()) toast('結帳面板打不開，請重新整理這一頁。');
        return;
      }

      if (target.hasAttribute('data-lm-checkout-go')) {
        if (live) {
          checkout(settings);
          return;
        }

        // 示範模式：訂單只留在這台瀏覽器裡，而且要講明白
        closeCheckout();
        toast('訂單記下來了（示範模式，沒有接金流、不會收費）');
        return;
      }

      if (target.hasAttribute('data-lm-cart-open')) {
        var lines = cart();
        toast(
          lines.length === 0
            ? '購物車是空的'
            : '購物車有 ' +
                cartCount(lines) +
                ' 件・小計 ' +
                money(
                  currency,
                  lines.reduce(function (sum, line) {
                    return sum + line.price * line.qty;
                  }, 0),
                ),
        );
        return;
      }

      if (target.hasAttribute('data-lm-follow')) {
        toast('已追蹤這個賣家（示範）');
        return;
      }

      if (target.hasAttribute('data-lm-close')) closeCheckout();
    });
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  } catch (error) {
    console.warn('[LocalMonkey] 重繪版型的前端沒啟動起來', error);
  }
})();
