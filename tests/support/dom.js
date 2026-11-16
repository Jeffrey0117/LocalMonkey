'use strict';

/**
 * 極簡假 DOM，給 GM shim 的單元測試用。
 *
 * 刻意不裝 jsdom（規格要求零依賴），但也刻意**不只斷言字串內容** ——
 * shim 是真的會在使用者頁面上跑的程式，要驗行為就得真的執行它。
 */

function createElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    textContent: '',
    parentNode: null,
    listeners: {},
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name)
        ? element.attributes[name]
        : null;
    },
    appendChild(child) {
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((candidate) => candidate !== child);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (element.parentNode) element.parentNode.removeChild(element);
    },
    addEventListener(type, handler) {
      element.listeners[type] = [...(element.listeners[type] ?? []), handler];
    },
    dispatch(type, event = {}) {
      for (const handler of element.listeners[type] ?? []) handler(event);
    },
    querySelectorAll() {
      return [];
    },
  };

  Object.defineProperty(element, 'innerHTML', {
    get: () => element.textContent,
    set: (value) => {
      element.textContent = String(value);
    },
  });

  return element;
}

function createStorage() {
  const map = new Map();

  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: (key) => map.delete(String(key)),
    clear: () => map.clear(),
  };
}

/**
 * @param {{ readyState?: string, clipboard?: 'ok'|'fail'|'missing',
 *           notification?: 'granted'|'denied'|'missing', storage?: 'ok'|'throws' }} [options]
 */
function createFakeDom(options = {}) {
  const warnings = [];
  const errors = [];
  const opened = [];
  const clipboardWrites = [];
  const notifications = [];
  const fetchCalls = [];
  const timers = [];

  const clicks = [];
  const objectUrls = [];
  const revokedUrls = [];

  /** 記下 .click()：GM_download 會用 <a download> + click，要驗它點了什麼 */
  function trackedCreateElement(tagName) {
    const element = createElement(tagName);
    element.click = () => {
      clicks.push(element);
      element.dispatch('click', {});
    };
    return element;
  }

  const head = trackedCreateElement('head');
  const body = trackedCreateElement('body');
  const documentElement = trackedCreateElement('html');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const storage = createStorage();
  const throwingStorage = {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
    get length() {
      throw new Error('storage disabled');
    },
    key: () => {
      throw new Error('storage disabled');
    },
  };

  const document = {
    readyState: options.readyState ?? 'complete',
    head,
    body,
    documentElement,
    listeners: {},
    createElement: trackedCreateElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, handler) {
      document.listeners[type] = [...(document.listeners[type] ?? []), handler];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const window = {
    document,
    location: { href: 'http://127.0.0.1:30600/p/demo/page', origin: 'http://127.0.0.1:30600' },
    localStorage: options.storage === 'throws' ? throwingStorage : storage,
    open: (url, target) => {
      opened.push({ url, target });
      return { closed: false, close: () => {} };
    },
    setTimeout: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: () => {},
    requestIdleCallback: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    navigator: {},
    URL: {
      createObjectURL: (blob) => {
        const url = 'blob:fake/' + (objectUrls.length + 1);
        objectUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL: (url) => revokedUrls.push(url),
    },
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/plain' },
            responseText: 'from upstream',
            finalUrl: 'https://api.example.com/x',
          }),
      });
    },
  };

  if (options.clipboard !== 'missing') {
    window.navigator.clipboard = {
      writeText: (text) => {
        clipboardWrites.push(text);
        return options.clipboard === 'fail'
          ? Promise.reject(new Error('denied'))
          : Promise.resolve();
      },
    };
  }

  if (options.notification !== 'missing') {
    const Notification = function FakeNotification(title, init) {
      notifications.push({ title, init });
      this.title = title;
      this.close = () => {};
    };
    Notification.permission = options.notification ?? 'granted';
    Notification.requestPermission = () => Promise.resolve(Notification.permission);
    window.Notification = Notification;
  }

  const sandbox = {
    window,
    document,
    localStorage: window.localStorage,
    navigator: window.navigator,
    location: window.location,
    fetch: window.fetch,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    JSON,
    Promise,
    Error,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    console: {
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
      info: () => {},
      log: () => {},
    },
  };

  if (window.Notification) sandbox.Notification = window.Notification;

  // shim 裡的 `window.X` 與裸 `X` 要指到同一個東西
  sandbox.globalThis = sandbox;
  window.window = window;
  window.self = window;
  // 預設是「最上層頁面」；測 @noframes 的呼叫端可以覆蓋成別的物件來模擬 iframe
  window.top = window;

  return {
    sandbox,
    window,
    document,
    head,
    body,
    storage,
    warnings,
    errors,
    opened,
    clipboardWrites,
    notifications,
    fetchCalls,
    clicks,
    objectUrls,
    revokedUrls,
    createElement: trackedCreateElement,
    drainTimers: () => {
      while (timers.length > 0) timers.shift()();
    },
    fireDomContentLoaded: () => {
      for (const handler of document.listeners.DOMContentLoaded ?? []) handler();
    },
  };
}

module.exports = { createFakeDom, createElement, createStorage };
