'use strict';

/**
 * HTML → 可翻譯文字段的清單（規格 §3）。
 *
 * ⛔ 刻意**不引入 HTML parser**：零依賴是這個專案的規則，而且 parser 會把
 * 壞掉的頁面「修正」成另一種東西 —— 代理必須把頁面原樣送出去，只動我們
 * 真正想動的那幾個 byte。所以這裡是一台狀態機，跟 `lib/html.js` 的網址
 * 改寫同一套路數（保守的掃描，看不懂的就不碰）。
 *
 * 回傳的每一段都帶 `start` / `end`，而且**保證** `html.slice(start, end) === raw`。
 * 回填靠的就是這個保證（`restore.js` 直接拿座標切字串），座標錯掉的症狀是
 * 版面爆開，而 curl 看起來「有翻譯」—— 所以有一條測試專門釘這件事。
 */

/** 這些元素的**內容**不是給人讀的文案（或是不能動的） */
const SKIP_ELEMENTS = new Set([
  'script',
  'style',
  'pre',
  'code',
  'textarea',
  'svg',
  'iframe',
  'noscript',
  'template',
]);

/** 規格 §3：這四個屬性要翻。`href` / `src` / `class` / `id` / `data-*` 不准碰。 */
const TRANSLATABLE_ATTRIBUTES = new Set(['alt', 'title', 'placeholder', 'aria-label']);

/** 沒有結束標籤的元素：不進巢狀堆疊，不然後面的文字會被歸到錯的元素底下 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const TAG_NAME = /^<(\/?)([a-zA-Z][^\s/>]*)/;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*')/g;

/**
 * 找這個標籤的 `>` 在哪。
 *
 * 不能直接 `indexOf('>')` —— `<a title="a > b">` 的屬性值裡就有一個。
 * 引號沒關起來就回 -1（那份 HTML 已經壞了，後面不要再猜）。
 */
function findTagEnd(html, from) {
  let index = from + 1;

  while (index < html.length) {
    const character = html[index];

    if (character === '"' || character === "'") {
      const closing = html.indexOf(character, index + 1);
      if (closing === -1) return -1;
      index = closing + 1;
      continue;
    }
    if (character === '>') return index;

    index += 1;
  }

  return -1;
}

/** `<` 之後真的是標籤名嗎？（`a < b` 裡那個不是，要當文字） */
function tagNameAt(html, at) {
  const matched = TAG_NAME.exec(html.slice(at, at + 128));
  return matched ? { closing: matched[1] === '/', tag: matched[2].toLowerCase() } : null;
}

/** 跳過區的結束標籤在哪（找不到＝文件就在跳過區裡結束了） */
function findClosingTag(html, tag, from) {
  return html.toLowerCase().indexOf(`</${tag}`, from);
}

/** 一個標籤裡所有「被引號包起來的」屬性，附上值在 tagSource 裡的座標 */
function attributesOf(tagSource) {
  const found = [];
  ATTRIBUTE.lastIndex = 0;

  let matched = ATTRIBUTE.exec(tagSource);
  while (matched !== null) {
    const [whole, name, quoted] = matched;
    const valueStart = matched.index + whole.length - quoted.length + 1;

    found.push({
      name: name.toLowerCase(),
      value: quoted.slice(1, -1),
      valueStart,
      valueEnd: valueStart + quoted.length - 2,
    });

    matched = ATTRIBUTE.exec(tagSource);
  }

  return found;
}

function isMetaDescription(attributes) {
  return attributes.some(
    (attribute) => attribute.name === 'name' && attribute.value.trim().toLowerCase() === 'description',
  );
}

/**
 * 這個標籤裡有哪些屬性要翻。
 * `<meta>` 走獨立規則：只有 `name="description"` 的 `content` 要翻
 * （`keywords`、`viewport` 翻了只會壞事）。
 */
function translatableAttributes(tag, attributes) {
  if (tag === 'meta') {
    return isMetaDescription(attributes)
      ? attributes.filter((attribute) => attribute.name === 'content')
      : [];
  }

  return attributes.filter((attribute) => TRANSLATABLE_ATTRIBUTES.has(attribute.name));
}

/** 巢狀堆疊：結束標籤把對應的開始標籤（以及中間沒關的）一起彈掉 */
function popTo(stack, tag) {
  const at = stack.lastIndexOf(tag);
  return at === -1 ? stack : stack.slice(0, at);
}

/**
 * @param {string} html latin1 管線字串也可以（標記本身全是 ASCII）
 * @returns {Array<{start: number, end: number, raw: string, kind: 'text'|'attribute', element: string|null, attribute?: string}>}
 */
function segmentHtml(html) {
  if (typeof html !== 'string') return [];

  const segments = [];
  let stack = [];
  let textStart = 0;
  let index = 0;

  const flushText = (end) => {
    if (end <= textStart) return;

    const raw = html.slice(textStart, end);
    if (raw.trim().length === 0) return;

    segments.push({
      start: textStart,
      end,
      raw,
      kind: 'text',
      element: stack.length > 0 ? stack[stack.length - 1] : null,
    });
  };

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) break;

    // 註解整段跳過（註解裡的標籤不是標籤）
    if (html.startsWith('<!--', lt)) {
      flushText(lt);
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) {
        textStart = html.length;
        break;
      }
      index = end + 3;
      textStart = index;
      continue;
    }

    // doctype / XML 宣告
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      flushText(lt);
      const end = html.indexOf('>', lt);
      if (end === -1) {
        textStart = html.length;
        break;
      }
      index = end + 1;
      textStart = index;
      continue;
    }

    const name = tagNameAt(html, lt);
    if (!name) {
      // 這個 `<` 是文字的一部分（`a < b`），文字段不要被切斷
      index = lt + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) {
      // 引號沒關的壞標籤：剩下的全部當標記，不再猜
      flushText(lt);
      textStart = html.length;
      break;
    }

    flushText(lt);

    if (name.closing) {
      stack = popTo(stack, name.tag);
      index = gt + 1;
      textStart = index;
      continue;
    }

    const selfClosing = html[gt - 1] === '/';

    if (SKIP_ELEMENTS.has(name.tag)) {
      if (selfClosing) {
        index = gt + 1;
        textStart = index;
        continue;
      }

      const closing = findClosingTag(html, name.tag, gt + 1);
      index = closing === -1 ? html.length : closing;
      textStart = index;
      continue;
    }

    for (const attribute of translatableAttributes(name.tag, attributesOf(html.slice(lt, gt + 1)))) {
      if (attribute.value.trim().length === 0) continue;

      segments.push({
        start: lt + attribute.valueStart,
        end: lt + attribute.valueEnd,
        raw: attribute.value,
        kind: 'attribute',
        element: name.tag,
        attribute: attribute.name,
      });
    }

    if (!selfClosing && !VOID_ELEMENTS.has(name.tag)) stack = [...stack, name.tag];

    index = gt + 1;
    textStart = index;
  }

  flushText(html.length);

  return segments;
}

module.exports = {
  segmentHtml,
  findTagEnd,
  attributesOf,
  SKIP_ELEMENTS,
  TRANSLATABLE_ATTRIBUTES,
  VOID_ELEMENTS,
};
