/* LocalMonkey 後台：共用的小工具。原生 JS，沒有 build step。 */
'use strict';

window.LocalMonkeyUi = (function createUi() {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /** 打字時不要每個按鍵都打一次 API */
  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, delay);
    };
  }

  const banner = {
    show(message, kind) {
      const element = byId('banner');
      if (!element) return;

      element.textContent = String(message);
      element.className = `banner is-${kind ?? 'info'}`;
      element.hidden = false;
    },
    error(error) {
      banner.show(error?.message ?? String(error), 'error');
    },
    hide() {
      const element = byId('banner');
      if (element) element.hidden = true;
    },
  };

  /** 複製代理網址。沒有 clipboard API 的話退回選取 + 提示。 */
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        banner.show(`已複製 ${text}`, 'ok');
        return true;
      }
    } catch (error) {
      banner.show(`複製失敗：${error.message}`, 'error');
      return false;
    }

    banner.show(`這個瀏覽器不給用剪貼簿，請手動複製：${text}`, 'warn');
    return false;
  }

  /** 事件委派：清單是重畫的，所以 listener 掛在容器上 */
  function delegate(container, selector, type, handler) {
    container.addEventListener(type, (event) => {
      const target = event.target.closest(selector);
      if (target && container.contains(target)) handler(event, target);
    });
  }

  return { escapeHtml, byId, debounce, banner, copyText, delegate };
})();
