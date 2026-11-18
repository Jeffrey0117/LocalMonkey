'use strict';

/**
 * 重繪版型的瀏覽器端：購物車、會員狀態、下載閘門（SPEC-reskin §4.3）。
 *
 * ⛔ **純前端示範，不接金流。** 購物車與會員狀態都在 `localStorage`，
 * 沒有任何東西會被送到伺服器。規格 §4.3 明說是這樣。
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
  var MEMBER_KEY = 'lm.reskin.member';

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
    if (!tag) return { currency: 'NT$', plans: [], item: null };

    try {
      return JSON.parse(tag.textContent);
    } catch (error) {
      console.warn('[LocalMonkey] 版型設定解析失敗', error);
      return { currency: 'NT$', plans: [], item: null };
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
   * 沒有 id 的時候用名稱當身分 —— 抽不到 id 不該讓加入購物車整個失效。
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

  /* ------------------------------- 會員 ------------------------------- */

  function member() {
    var value = readStore(MEMBER_KEY);
    return value && typeof value.plan === 'string' ? value : null;
  }

  function paintMember() {
    var current = member();
    each('[data-lm-member-label]', function (node) {
      node.textContent = current ? current.plan + ' 會員' : '訪客';
    });
  }

  function join(planId, plans) {
    var picked = plans.filter(function (plan) {
      return plan.id === planId;
    })[0];
    if (!picked) return null;

    writeStore(MEMBER_KEY, { plan: picked.name, planId: picked.id, at: Date.now() });
    paintMember();
    return picked;
  }

  /* --------------------------- 方案面板（閘門） --------------------------- */

  function dialog() {
    return document.querySelector('[data-lm-plans]');
  }

  function openPlans() {
    var node = dialog();
    if (!node) return false;

    // 舊瀏覽器沒有 showModal：退回「直接顯示」而不是整個功能死掉
    if (typeof node.showModal === 'function') node.showModal();
    else node.setAttribute('open', '');

    return true;
  }

  function closePlans() {
    var node = dialog();
    if (!node) return;

    if (typeof node.close === 'function') node.close();
    else node.removeAttribute('open');
  }

  /* ------------------------- 商品頁的方案與數量 ------------------------- */

  function selectedPlan(plans) {
    var pressed = document.querySelector('[data-lm-plan][aria-pressed="true"]');
    var id = pressed ? pressed.getAttribute('data-lm-plan') : null;

    var found = plans.filter(function (plan) {
      return plan.id === id;
    })[0];

    return found || plans[0] || { id: 'free', name: '免費版', price: 0 };
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

    paintCart();
    paintMember();
    if (plans.length > 0) paintPrice(currency, selectedPlan(plans));

    document.addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('[data-lm-plan],[data-lm-qty],[data-lm-add],[data-lm-buy],[data-lm-download],[data-lm-join],[data-lm-close],[data-lm-cart-open],[data-lm-follow],[data-lm-pick]') : null;
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

      /* 購物車 */
      if (target.hasAttribute('data-lm-add') || target.hasAttribute('data-lm-buy')) {
        if (!settings.item) return;

        var plan = selectedPlan(plans);
        addToCart(settings.item, plan, quantity());

        if (target.hasAttribute('data-lm-buy')) {
          // 「立即購買」＝加進購物車然後走結帳，而結帳就是入會（沒有金流）
          if (!member()) {
            openPlans();
            return;
          }
          toast('已送出訂單（示範，不會真的收費）');
          return;
        }

        toast('已加入購物車：' + plan.name);
        return;
      }

      if (target.hasAttribute('data-lm-cart-open')) {
        var lines = cart();
        toast(
          lines.length === 0
            ? '購物車是空的'
            : '購物車有 ' + cartCount(lines) + ' 件・小計 ' + money(currency, lines.reduce(function (sum, line) {
                return sum + line.price * line.qty;
              }, 0)),
        );
        return;
      }

      if (target.hasAttribute('data-lm-follow')) {
        toast('已追蹤這個賣家（示範）');
        return;
      }

      /* ⛔ 下載閘門：不是會員就開方案面板，而且**要擋掉那次導航** */
      if (target.hasAttribute('data-lm-download')) {
        if (member()) return;

        event.preventDefault();
        if (!openPlans()) toast('請先選一個方案才能下載');
        return;
      }

      /* 面板裡的按鈕 */
      var joinId = target.getAttribute('data-lm-join');
      if (joinId !== null) {
        var joined = join(joinId, plans);
        closePlans();
        if (joined) {
          toast(
            joined.price === 0
              ? '已成為 ' + joined.name + ' 會員，現在可以下載了'
              : '已開通 ' + joined.name + '（示範，不會真的收費）',
          );
        }
        return;
      }

      if (target.hasAttribute('data-lm-close')) closePlans();
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
