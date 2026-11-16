/*
 * LocalMonkey GM shim —— 在被代理的頁面上跑的程式。
 *
 * 規則（比功能重要）：
 *   1. 任何自己的錯誤都吞掉 + console.warn。**絕不能弄壞被代理的原站。**
 *   2. 只掛一個全域名字：window.__localMonkey。
 *   3. 每支使用者腳本拿到自己的 api 物件（放在 __localMonkey.apis[scriptId]），
 *      由該腳本的 wrapper 宣告成區域變數 —— 不往 window 塞 GM_*，
 *      否則同一頁多支腳本會互相蓋掉（document-idle 的腳本最容易中）。
 *   4. 只暴露 @grant 列出的 API，跟 Tampermonkey 一致。
 *
 * 這個檔案是直接送給瀏覽器的（沒有 build step），所以用 ES5 寫法。
 */
(function () {
  'use strict';

  var root = (window.__localMonkey = window.__localMonkey || {});
  root.apis = root.apis || {};

  if (root.createGM) {
    // 同一頁第二支腳本：工廠已經在了，不要重新定義（會把閉包換掉）
    return;
  }

  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  var VALUE_PREFIX = '__lm_gm_';
  var HANDLER_NAME = 'LocalMonkey';
  var HANDLER_VERSION = '2.0';

  function warn(message, detail) {
    try {
      console.warn('[LocalMonkey] ' + message, detail === undefined ? '' : detail);
    } catch (ignored) {
      /* console 都沒了就真的沒辦法了 */
    }
  }

  /** 把 fn 包成「永不往外丟錯」的版本 */
  function guard(label, fn, fallback) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (error) {
        warn(label + ' 執行失敗', error);
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    };
  }

  function mountPoint() {
    return document.body || document.documentElement;
  }

  /** 浮動 UI 一律 all:initial，避免被原站的 CSS 汙染（也避免汙染原站） */
  function isolatedBox(kind) {
    var box = document.createElement('div');
    box.setAttribute('data-localmonkey', kind);
    box.style.all = 'initial';
    box.style.position = 'fixed';
    box.style.right = '16px';
    box.style.zIndex = '2147483000';
    box.style.fontFamily = 'system-ui, sans-serif';
    box.style.fontSize = '13px';
    box.style.lineHeight = '1.5';
    box.style.color = '#f4f4f5';
    return box;
  }

  /* ------------------------------ 值的儲存 ------------------------------ */

  function createValueStore(scriptId) {
    var prefix = VALUE_PREFIX + scriptId + '_';

    function storage() {
      return window.localStorage;
    }

    return {
      prefix: prefix,
      set: guard('GM_setValue', function (key, value) {
        storage().setItem(prefix + key, JSON.stringify(value));
      }),
      get: function (key, fallback) {
        try {
          var raw = storage().getItem(prefix + key);
          if (raw === null || raw === undefined) return fallback;
          return JSON.parse(raw);
        } catch (error) {
          warn('GM_getValue 讀不回來，改用預設值', error);
          return fallback;
        }
      },
      remove: guard('GM_deleteValue', function (key) {
        storage().removeItem(prefix + key);
      }),
      list: guard(
        'GM_listValues',
        function () {
          var store = storage();
          var keys = [];
          for (var index = 0; index < store.length; index += 1) {
            var key = store.key(index);
            if (key && key.indexOf(prefix) === 0) keys.push(key.slice(prefix.length));
          }
          return keys;
        },
        function () {
          return [];
        },
      ),
    };
  }

  /* ------------------------------ 選單 ------------------------------ */

  function createMenu() {
    var container = null;
    var open = false;
    var counter = 0;

    function ensureContainer() {
      if (container) return container;

      container = isolatedBox('menu');
      container.style.bottom = '16px';
      container.style.display = 'block';

      var toggle = document.createElement('button');
      toggle.setAttribute('data-lm-menu-toggle', '1');
      toggle.textContent = '🐒';
      toggle.style.all = 'initial';
      toggle.style.cursor = 'pointer';
      toggle.style.fontSize = '18px';
      toggle.style.background = '#18181b';
      toggle.style.border = '1px solid #3f3f46';
      toggle.style.borderRadius = '999px';
      toggle.style.padding = '6px 10px';
      toggle.addEventListener('click', function () {
        open = !open;
        for (var index = 0; index < container.children.length; index += 1) {
          var child = container.children[index];
          if (child.getAttribute && child.getAttribute('data-lm-command')) {
            child.style.display = open ? 'block' : 'none';
          }
        }
      });

      container.appendChild(toggle);
      mountPoint().appendChild(container);
      return container;
    }

    return {
      register: guard('GM_registerMenuCommand', function (caption, callback) {
        var box = ensureContainer();
        counter += 1;
        var id = 'lm_menu_' + counter;

        var entry = document.createElement('button');
        entry.setAttribute('data-lm-command', id);
        entry.textContent = String(caption);
        entry.style.all = 'initial';
        entry.style.display = 'none';
        entry.style.cursor = 'pointer';
        entry.style.background = '#27272a';
        entry.style.color = '#f4f4f5';
        entry.style.border = '1px solid #3f3f46';
        entry.style.borderRadius = '6px';
        entry.style.padding = '6px 10px';
        entry.style.marginTop = '6px';
        entry.style.fontFamily = 'system-ui, sans-serif';
        entry.style.fontSize = '13px';
        entry.addEventListener('click', function () {
          try {
            callback();
          } catch (error) {
            warn('選單指令「' + caption + '」執行失敗', error);
          }
        });

        box.appendChild(entry);
        return id;
      }),
    };
  }

  /* ------------------------------ 通知 ------------------------------ */

  function showToast(text) {
    var toast = isolatedBox('toast');
    toast.style.top = '16px';
    toast.style.background = '#18181b';
    toast.style.border = '1px solid #3f3f46';
    toast.style.borderRadius = '8px';
    toast.style.padding = '10px 14px';
    toast.style.maxWidth = '320px';
    toast.textContent = String(text);

    mountPoint().appendChild(toast);
    window.setTimeout(function () {
      try {
        toast.remove();
      } catch (ignored) {
        /* 頁面可能已經換掉了 */
      }
    }, 6000);

    return toast;
  }

  function notify(details, title) {
    var options = typeof details === 'string' ? { text: details, title: title } : details || {};
    var text = options.text === undefined ? '' : String(options.text);
    var heading = options.title === undefined ? HANDLER_NAME : String(options.title);

    var Ctor = window.Notification;
    if (Ctor && Ctor.permission === 'granted') {
      var notification = new Ctor(heading, { body: text, icon: options.image });
      if (typeof options.onclick === 'function') {
        try {
          notification.onclick = options.onclick;
        } catch (ignored) {
          /* 某些瀏覽器不給設 */
        }
      }
      return notification;
    }

    if (Ctor && Ctor.permission === 'default' && typeof Ctor.requestPermission === 'function') {
      // 下一次就有權限了；這一次先用頁面內提示，不要卡住呼叫端
      try {
        Ctor.requestPermission();
      } catch (ignored) {
        /* 舊版是 callback 形式，失敗就算了 */
      }
    }

    return showToast(heading && text ? heading + '：' + text : heading || text);
  }

  /* ------------------------------ GM_xmlhttpRequest ------------------------------ */

  function headerString(headers) {
    var source = headers || {};
    var lines = [];
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        lines.push(key + ': ' + source[key]);
      }
    }
    return lines.join('\r\n');
  }

  function createXhr(config) {
    return function GM_xmlhttpRequest(details) {
      var options = details || {};
      var aborted = false;
      var controller = null;

      if (typeof AbortController !== 'undefined') {
        try {
          controller = new AbortController();
        } catch (ignored) {
          controller = null;
        }
      }

      function fail(payload) {
        if (aborted) return;
        if (typeof options.onerror === 'function') {
          try {
            options.onerror(payload);
            return;
          } catch (error) {
            warn('GM_xmlhttpRequest 的 onerror 自己丟錯', error);
            return;
          }
        }
        warn('GM_xmlhttpRequest 失敗', payload);
      }

      function succeed(payload) {
        if (aborted) return;
        var response = {
          readyState: 4,
          status: payload.status,
          statusText: payload.statusText,
          responseHeaders: headerString(payload.headers),
          responseText: payload.responseText,
          response: payload.responseText,
          finalUrl: payload.finalUrl,
          context: options.context,
        };

        if (typeof options.onload === 'function') {
          try {
            options.onload(response);
          } catch (error) {
            warn('GM_xmlhttpRequest 的 onload 自己丟錯', error);
          }
        }
      }

      try {
        var body = {
          scriptId: config.scriptId,
          method: options.method || 'GET',
          url: options.url,
          headers: options.headers || {},
          data: options.data,
          timeout: options.timeout,
        };

        var init = {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
        if (controller) init.signal = controller.signal;

        var send = window.fetch || fetch;
        send.call(window, config.xhrEndpoint, init)
          .then(function (response) {
            return response.json().then(
              function (payload) {
                return { ok: response.ok, status: response.status, payload: payload };
              },
              function () {
                return { ok: false, status: response.status, payload: {} };
              },
            );
          })
          .then(function (result) {
            if (!result.ok) {
              fail({
                status: result.status,
                error: result.payload.error,
                message: result.payload.message,
              });
              return;
            }
            succeed(result.payload);
          })
          .catch(function (error) {
            fail({ status: 0, error: 'network_error', message: String((error && error.message) || error) });
          });
      } catch (error) {
        fail({ status: 0, error: 'shim_error', message: String((error && error.message) || error) });
      }

      return {
        abort: function () {
          aborted = true;
          if (controller) {
            try {
              controller.abort();
            } catch (ignored) {
              /* 已經結束了 */
            }
          }
        },
      };
    };
  }

  /* ------------------------------ 組裝 ------------------------------ */

  function buildImplementations(config) {
    var values = createValueStore(config.scriptId);
    var menu = createMenu();
    var resources = config.resources || {};

    function resourceEntry(name) {
      var entry = resources[name];
      if (!entry) {
        warn('@resource「' + name + '」沒有宣告（或抓取失敗）');
        return null;
      }
      return entry;
    }

    var info = {
      scriptHandler: HANDLER_NAME,
      version: HANDLER_VERSION,
      scriptMetaStr: config.metaStr || '',
      script: {
        name: config.name,
        version: config.version,
        namespace: config.namespace,
        description: config.description,
        runAt: config.runAt,
        matches: config.matches || [],
        includes: config.includes || [],
        excludes: config.excludes || [],
        grant: config.grants || [],
      },
    };

    return {
      unsafeWindow: window,
      GM_info: info,
      GM_addStyle: guard('GM_addStyle', function (css) {
        var style = document.createElement('style');
        style.setAttribute('data-localmonkey', 'style');
        style.textContent = String(css);
        (document.head || document.documentElement).appendChild(style);
        return style;
      }, null),
      GM_setValue: values.set,
      GM_getValue: values.get,
      GM_deleteValue: values.remove,
      GM_listValues: values.list,
      GM_openInTab: guard('GM_openInTab', function (url, openOptions) {
        var background = openOptions === true || (openOptions && openOptions.active === false);
        var handle = window.open(String(url), background ? '_blank' : '_blank');
        return handle || { closed: true, close: function () {} };
      }, null),
      GM_setClipboard: function (text) {
        try {
          var clipboard = window.navigator && window.navigator.clipboard;
          if (!clipboard || typeof clipboard.writeText !== 'function') {
            warn('這個瀏覽器不給用 navigator.clipboard，GM_setClipboard 沒有生效');
            return false;
          }

          var result = clipboard.writeText(String(text));
          if (result && typeof result.catch === 'function') {
            result.catch(function (error) {
              warn('GM_setClipboard 被瀏覽器拒絕（通常是因為沒有使用者手勢）', error);
            });
          }
          return true;
        } catch (error) {
          warn('GM_setClipboard 執行失敗', error);
          return false;
        }
      },
      GM_registerMenuCommand: menu.register,
      GM_notification: guard('GM_notification', notify, null),
      GM_getResourceText: function (name) {
        var entry = resourceEntry(name);
        if (!entry) return null;
        if (typeof entry.text !== 'string') {
          warn('@resource「' + name + '」不是文字內容（或太大），GM_getResourceText 回 null');
          return null;
        }
        return entry.text;
      },
      GM_getResourceURL: function (name) {
        var entry = resourceEntry(name);
        return entry && entry.assetUrl ? entry.assetUrl : null;
      },
      GM_xmlhttpRequest: createXhr(config),
    };
  }

  /** GM4 的點號形式：同樣的功能，但回 Promise */
  function buildGm4(implementations) {
    function promisify(fn) {
      return function () {
        var args = arguments;
        return new Promise(function (resolve, reject) {
          try {
            resolve(fn.apply(null, args));
          } catch (error) {
            reject(error);
          }
        });
      };
    }

    return {
      setValue: promisify(implementations.GM_setValue),
      getValue: promisify(implementations.GM_getValue),
      deleteValue: promisify(implementations.GM_deleteValue),
      listValues: promisify(implementations.GM_listValues),
      addStyle: promisify(implementations.GM_addStyle),
      openInTab: promisify(implementations.GM_openInTab),
      setClipboard: promisify(implementations.GM_setClipboard),
      notification: promisify(implementations.GM_notification),
      registerMenuCommand: promisify(implementations.GM_registerMenuCommand),
      getResourceText: promisify(implementations.GM_getResourceText),
      getResourceUrl: promisify(implementations.GM_getResourceURL),
      getResourceURL: promisify(implementations.GM_getResourceURL),
      info: implementations.GM_info,
      xmlHttpRequest: implementations.GM_xmlhttpRequest,
    };
  }

  function unsupportedStub(name) {
    return function () {
      try {
        console.error(
          '[LocalMonkey] 尚未支援 ' + name + '：這支腳本用到的這個 GM API 在 LocalMonkey 沒有實作，' +
            '這一行不會有任何效果（後台該腳本的權限列有紅字標示）。',
        );
      } catch (ignored) {
        /* 沒有 console 就算了 */
      }
      return undefined;
    };
  }

  /**
   * @param {object} config 由伺服器端 render 進來（見 src/lib/gm-shim.js）
   * @returns {object} 只含該腳本 @grant 過的 API
   */
  root.createGM = function createGM(config) {
    var implementations = buildImplementations(config);
    var grants = config.grants || [];
    var api = {};
    var needsGm4 = false;

    for (var index = 0; index < grants.length; index += 1) {
      var grant = grants[index];
      if (typeof grant !== 'string') continue;

      if (grant.indexOf('GM.') === 0) {
        if (IDENTIFIER.test(grant.slice(3))) needsGm4 = true;
        continue;
      }
      if (!IDENTIFIER.test(grant)) continue;

      api[grant] = Object.prototype.hasOwnProperty.call(implementations, grant)
        ? implementations[grant]
        : unsupportedStub(grant);
    }

    if (needsGm4) api.GM = buildGm4(implementations);

    return api;
  };

  root.install = function install(config) {
    try {
      root.apis[config.scriptId] = root.createGM(config);
    } catch (error) {
      warn('GM shim 初始化失敗，這支腳本拿不到 GM_* API', error);
      root.apis[config.scriptId] = {};
    }
  };
})();
