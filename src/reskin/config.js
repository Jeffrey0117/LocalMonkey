'use strict';

/**
 * 抽取設定（SPEC-reskin §3.1）：宣告式的 JSON → 可執行的形狀。
 *
 * ⛔ **這一層是可拋棄的。** 使用者真正在做的是自己的模板商城，被代理的站只是
 * 「真實感的假資料」（規格 §0）。所以設定綁死在上游的 DOM 上**是對的** ——
 * 之後換資料來源就整份換掉。代價是：版型層一個字都不准知道這裡寫了什麼。
 *
 * 設定長相：
 *
 * ```js
 * {
 *   match: '^/page/\\d+$',       // 路徑正則 → 這是哪種頁面
 *   kind:  'listing',             // listing | product
 *   id:    '/item-(\\d+)',        // 從網址取 id（可省）
 *   item:  '.card',               // listing：每一項的容器
 *   fields: {                     // 有 item 時 → 每一項；沒有 → 整份文件
 *     name:  { sel: 'h2 a', attr: 'text' },
 *     url:   { sel: 'h2 a', attr: 'href', as: 'url' },
 *   },
 *   page: { totalPages: { sel: '.info', attr: 'text', extract: 'of (\\d+)', as: 'number' } },
 *   search: { action: '/search', param: 'q' },   // 省略 → 版型畫一個不作用的搜尋列並標示
 * }
 * ```
 *
 * 欄位的五個鍵，每個只做一件事：
 *
 * | 鍵 | 作用 |
 * |---|---|
 * | `sel` | 選擇器（`query.js`，＝ `scope` 那一套子集） |
 * | `attr` | `text`（遞迴文字）或任意屬性名 |
 * | `as` | `text`（預設）/ `url`（補成代理網址）/ `number`（去掉千分位）/ `link`（`{name,url}`） |
 * | `many` | 要全部（標籤、分類列），預設只要第一個**有值的** |
 * | `when` | 候選元素的守門員：`{ attr, match }`，比對不中就跳過 |
 * | `extract` | 對抽出來的值再跑一次正則，取第 1 個捕獲群組 |
 *
 * `when` 與 `extract` 看起來重複，實際上是兩個不同的無解問題：
 *   - `when`：標籤連結與「這個模板 100% 免費下載」的連結**同一個容器、同一個
 *     選擇器**，只有 `href` 的前綴分得出來。而 `[href^=...]` 是 `scope` 文法
 *     明確拒絕的（拒絕比忽略安全，見 `rules/scope.js`）。
 *   - `extract`：觀看數與下載數在上游是**裸的文字節點**（`<strong>Views:</strong>
 *     11,249`），沒有任何元素包著它 —— 選擇器再強也抓不到，只有正則抓得到。
 *
 * 單值欄位是「第一個**有值的**候選」而不是「第一個候選」：上面那個 `Views:`
 * 的選擇器會配到同一個容器裡的好幾個 `<p>`，只有其中一個 `extract` 得出東西。
 */

const { compileSelector } = require('./query.js');
const { compileUserRegex } = require('../rules/user-regex.js');

const KINDS = Object.freeze(['listing', 'product']);
/**
 * `link` 是給「標籤膠囊」「分類列」這種**又要文字又要網址**的清單用的：
 * 一個元素身上同時取 `text` 與 `href`，回 `{ name, url }`。沒有它的話使用者
 * 得寫兩個同選擇器的欄位再靠索引配對 —— 那在上游少一個連結的時候會錯位，
 * 而錯位是靜默的。用 `link` 的欄位 `attr` 不生效（文件裡寫明了）。
 */
const CASTS = Object.freeze(['text', 'url', 'number', 'link']);

const MAX_RULES = 20;
const MAX_FIELDS = 30;
const MAX_CONFIG_BYTES = 20000;

function fail(path, message) {
  return { ok: false, error: `${path}：${message}` };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 使用者的正則全部走 `rules/user-regex.js`（嵌套量詞攔截在那裡） */
function compileRegex(pattern, path) {
  const compiled = compileUserRegex(pattern);
  return compiled.ok ? { ok: true, value: compiled.value } : fail(path, compiled.error);
}

function compileWhen(when, path) {
  if (when === undefined || when === null) return { ok: true, value: null };
  if (!isPlainObject(when)) return fail(path, 'when 必須是物件 { attr, match }');

  const attr = typeof when.attr === 'string' && when.attr.length > 0 ? when.attr : 'text';
  const matcher = compileRegex(when.match, `${path}.match`);
  if (!matcher.ok) return matcher;

  return { ok: true, value: { attr, matcher: matcher.value } };
}

function compileField(spec, path) {
  if (!isPlainObject(spec)) return fail(path, '欄位必須是物件');

  const selector = compileSelector(spec.sel);
  if (!selector.ok) return fail(`${path}.sel`, selector.error);

  const attr = spec.attr === undefined ? 'text' : spec.attr;
  if (typeof attr !== 'string' || attr.length === 0 || attr.length > 64) {
    return fail(`${path}.attr`, "attr 必須是 'text' 或一個屬性名");
  }

  const as = spec.as === undefined ? 'text' : spec.as;
  if (!CASTS.includes(as)) return fail(`${path}.as`, `as 只能是 ${CASTS.join(' / ')}`);

  if (spec.many !== undefined && typeof spec.many !== 'boolean') {
    return fail(`${path}.many`, 'many 只接受 true/false');
  }

  const when = compileWhen(spec.when, `${path}.when`);
  if (!when.ok) return when;

  let extract = null;
  if (spec.extract !== undefined && spec.extract !== null && spec.extract !== '') {
    const compiled = compileRegex(spec.extract, `${path}.extract`);
    if (!compiled.ok) return compiled;
    extract = compiled.value;
  }

  return {
    ok: true,
    value: {
      selector: selector.value,
      attr,
      as,
      many: spec.many === true,
      when: when.value,
      extract,
    },
  };
}

function compileFieldMap(fields, path) {
  if (fields === undefined || fields === null) return { ok: true, value: {} };
  if (!isPlainObject(fields)) return fail(path, '必須是物件');

  const names = Object.keys(fields);
  if (names.length > MAX_FIELDS) return fail(path, `最多 ${MAX_FIELDS} 個欄位`);

  return names.reduce(
    (acc, name) => {
      if (!acc.ok) return acc;
      if (!/^[a-zA-Z][\w-]{0,40}$/.test(name)) {
        return fail(`${path}.${name}`, '欄位名只能是英數與 _ -，開頭是字母');
      }

      const field = compileField(fields[name], `${path}.${name}`);
      return field.ok ? { ok: true, value: { ...acc.value, [name]: field.value } } : field;
    },
    { ok: true, value: {} },
  );
}

function compileSearch(search, path) {
  if (search === undefined || search === null) return { ok: true, value: null };
  if (!isPlainObject(search)) return fail(path, '必須是物件 { action, param }');

  const { action, param } = search;
  if (typeof action !== 'string' || !action.startsWith('/')) {
    return fail(`${path}.action`, 'action 必須是上游的路徑（開頭是 /）');
  }
  if (typeof param !== 'string' || !/^[\w-]{1,32}$/.test(param)) {
    return fail(`${path}.param`, 'param 必須是查詢參數名');
  }

  return { ok: true, value: { action, param } };
}

/** 一條設定（一種頁面） */
function compileEntry(entry, path) {
  if (!isPlainObject(entry)) return fail(path, '必須是物件');

  if (!KINDS.includes(entry.kind)) return fail(`${path}.kind`, `kind 只能是 ${KINDS.join(' / ')}`);

  const match = compileRegex(entry.match, `${path}.match`);
  if (!match.ok) return match;

  let item = null;
  if (entry.item !== undefined && entry.item !== null && entry.item !== '') {
    const compiled = compileSelector(entry.item);
    if (!compiled.ok) return fail(`${path}.item`, compiled.error);
    item = compiled.value;
  }

  let id = null;
  if (entry.id !== undefined && entry.id !== null && entry.id !== '') {
    const compiled = compileRegex(entry.id, `${path}.id`);
    if (!compiled.ok) return compiled;
    id = compiled.value;
  }

  const fields = compileFieldMap(entry.fields, `${path}.fields`);
  if (!fields.ok) return fields;

  const page = compileFieldMap(entry.page, `${path}.page`);
  if (!page.ok) return page;

  const search = compileSearch(entry.search, `${path}.search`);
  if (!search.ok) return search;

  if (Object.keys(fields.value).length === 0) {
    return fail(`${path}.fields`, '至少要有一個欄位，不然抽不到任何東西');
  }

  return {
    ok: true,
    value: {
      kind: entry.kind,
      match: match.value,
      item,
      id,
      fields: fields.value,
      page: page.value,
      search: search.value,
      note: typeof entry.note === 'string' ? entry.note : null,
    },
  };
}

/**
 * 整份設定（一個陣列，**順序就是比對順序**：第一個命中的勝出，規格 §3.1）。
 *
 * @param {unknown} source 陣列、或它的 JSON 字串（DB 存的是字串）
 * @returns {{ ok: true, value: Array<object> }|{ ok: false, error: string }}
 */
function compileConfig(source) {
  if (source === undefined || source === null || source === '') return { ok: true, value: [] };

  let parsed = source;
  if (typeof source === 'string') {
    if (source.length > MAX_CONFIG_BYTES) {
      return { ok: false, error: `設定最長 ${MAX_CONFIG_BYTES} 個字` };
    }
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      return { ok: false, error: `不是合法的 JSON：${error.message}` };
    }
  }

  if (parsed === null) return { ok: true, value: [] };
  if (!Array.isArray(parsed)) return { ok: false, error: '設定必須是一個陣列（一種頁面一筆）' };
  if (parsed.length > MAX_RULES) return { ok: false, error: `最多 ${MAX_RULES} 筆` };

  return parsed.reduce(
    (acc, entry, index) => {
      if (!acc.ok) return acc;
      const compiled = compileEntry(entry, `[${index}]`);
      return compiled.ok ? { ok: true, value: [...acc.value, compiled.value] } : compiled;
    },
    { ok: true, value: [] },
  );
}

/**
 * 哪一筆設定管這個路徑？
 *
 * ⛔ `lastIndex = 0`：`compileUserRegex` 一律帶 `g` 旗標，而 `test()` 會把
 * `lastIndex` 往前推 —— 同一條設定比到第二個請求時就會從上次的位置開始找，
 * 於是「有些頁面重繪、有些沒有」而且毫無規律（`rules/no-translate.js` 踩過
 * 同一個坑）。
 *
 * @param {Array<object>} compiled
 * @param {string} pathname 不含 query
 */
function findEntry(compiled, pathname) {
  if (!Array.isArray(compiled) || typeof pathname !== 'string') return null;

  return (
    compiled.find((entry) => {
      entry.match.lastIndex = 0;
      return entry.match.test(pathname);
    }) ?? null
  );
}

module.exports = { compileConfig, compileEntry, findEntry, KINDS, CASTS, MAX_CONFIG_BYTES };
