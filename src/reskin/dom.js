'use strict';

/**
 * HTML → 一棵很小的樹（SPEC-reskin §3.2）。
 *
 * ⛔ **這是本專案第一次「解析」HTML 而不只是掃描它**，所以先講清楚為什麼，
 * 以及為什麼仍然沒有引入依賴。
 *
 * 既有的兩套「伺服器端用選擇器」是：
 *
 *   - `rules/scope.js`（v5）—— 祖先鏈的子集比對。它回答「**這一段文字**在
 *     某個選擇器裡面嗎」，而重繪要問的是「**把符合這個選擇器的元素都給我**，
 *     連它的 `href` 與 `src`」。切段器根本不產出 `href` / `src`
 *     （`TRANSLATABLE_ATTRIBUTES` 只有 alt / title / placeholder / aria-label），
 *     而且它把文件攤平成一串段，沒有「這 16 張卡片各自的範圍」這種概念。
 *   - `rules/no-translate.js`（v7）—— 刻意是**文字比對**不是選擇器。
 *
 * 兩套都撐不住抽取（規格 §3.2 也預期了這個結論：「要取屬性、要取巢狀」），
 * 但結論**不是**「引入 parser 依賴」，而是：**缺的只有一棵樹**。
 *
 * 分詞器已經寫好了，就在 `translate/segment.js` 裡，而且已經被 1345 條測試
 * 磨過：`findTagEnd`（引號感知的 `>`）、`attributesOf`（屬性值 + 座標）、
 * `elementInfo`（tag / id / classes）、`VOID_ELEMENTS`、`SKIP_ELEMENTS`。
 * 這支只做一件既有程式碼沒做的事：**把那串 token 疊成父子關係**。
 * 選擇器比對則原樣沿用 `rules/scope.js` 的文法（見 `query.js`）——
 * 所以使用者在 `scope` 學到的語法，在重繪設定裡是同一套。
 *
 * ⛔ 刻意**不**當一個通用的 HTML parser：
 *   - 不做錯誤修正（不補 `<p>` 的隱含結束、不處理 `<table>` 的 foster parenting）。
 *     parser 會把壞頁面「修正」成另一種東西 —— 但我們不是要把樹送出去，
 *     送出去的是**我們自己產生的** HTML（版型層），樹只是讀資料用的。
 *     看不懂的地方抽不到欄位，而抽不到就退回代理模式（規格 §7.2）。
 *   - 不保留座標。回填不走這條路（整份文件是重畫的，不是改寫的），
 *     所以 `segment.js` 那條「`html.slice(start,end) === raw`」的契約在這裡
 *     沒有意義，省掉它換得程式碼少一半。
 *   - 只在**重繪路徑**用。代理 / 翻譯 / 規則三條既有管線一個 byte 都沒動。
 */

const {
  findTagEnd,
  attributesOf,
  VOID_ELEMENTS,
  SKIP_ELEMENTS,
} = require('../translate/segment.js');

/** 這些元素的內容不是資料（而且裡面的 `<` 不是標籤） */
const OPAQUE_ELEMENTS = new Set([...SKIP_ELEMENTS]);

const TAG_NAME = /^<(\/?)([a-zA-Z][^\s/>]*)/;

/**
 * 太深的巢狀就停。真實頁面很少超過 30 層，而「停在這裡」比「堆到爆」好 ——
 * 超過的元素變成最後一個合法祖先的子節點，抽取頂多少拿到幾個欄位。
 */
const MAX_DEPTH = 64;

function tagNameAt(html, at) {
  const matched = TAG_NAME.exec(html.slice(at, at + 128));
  return matched ? { closing: matched[1] === '/', tag: matched[2].toLowerCase() } : null;
}

function makeNode(tag, attributes) {
  const map = attributes.reduce((acc, attribute) => {
    // 同名屬性取第一個（瀏覽器也是這樣），而且 name 已經被 attributesOf 小寫化
    return attribute.name in acc ? acc : { ...acc, [attribute.name]: attribute.value };
  }, {});

  const classAttribute = map.class ?? '';
  const id = (map.id ?? '').trim();

  return {
    tag,
    id: id.length > 0 ? id : null,
    classes: classAttribute.split(/\s+/).filter((name) => name.length > 0),
    attrs: map,
    /**
     * ⛔ 文字節點也進 `children`（`tag: '#text'`），**順序不能丟**。
     *
     * 第一版把元素的直接文字累加在 `node.text` 上、子元素另外放 —— 結果
     * `textOf()` 會吐出「所有直接文字」再接「所有子元素的文字」，文件順序
     * 整個散掉。實測現場：`<p><strong>Views:</strong> 11,249 <strong>Downloads:</strong>
     * 1,354</p>` 變成 `11,249 1,354Views:Downloads:`，於是
     * `Views:\s*([\d,]+)` 這條 `extract` **永遠抽不到**。
     * 症狀是「觀看數跟下載數一直是空的」，而選擇器怎麼看都是對的。
     */
    children: [],
  };
}

function textNode(text) {
  return { tag: '#text', id: null, classes: [], attrs: {}, children: [], text };
}

/** 選擇器只能配到元素（`*` 也不准配到文字節點） */
function isElement(node) {
  return node.tag !== '#text';
}

/**
 * 建樹。回的是一個合成的根節點（`tag: '#root'`），它不參與選擇器比對。
 *
 * @param {string} html 真文字（**不是** latin1 管線字串 —— 抽出來的值會進
 *   我們的資料模型，而版型層要的是能直接印出來的文字。呼叫端負責在邊界上
 *   `fromLatin1`，理由同 `translate/bytes.js`）
 * @returns {{ tag: '#root', children: Array<object> }}
 */
function parseDocument(html) {
  const root = { tag: '#root', id: null, classes: [], attrs: {}, children: [], text: '' };
  if (typeof html !== 'string' || html.length === 0) return root;

  let stack = [root];
  let index = 0;
  let textStart = 0;

  const top = () => stack[stack.length - 1];

  const flushText = (end) => {
    if (end <= textStart) return;
    const raw = html.slice(textStart, end);
    if (raw.trim().length === 0) return;
    top().children.push(textNode(raw));
  };

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) break;

    // 註解、doctype、XML 宣告：整段不是資料
    if (html.startsWith('<!--', lt)) {
      flushText(lt);
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      index = end + 3;
      textStart = index;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      flushText(lt);
      const end = html.indexOf('>', lt);
      if (end === -1) break;
      index = end + 1;
      textStart = index;
      continue;
    }

    const name = tagNameAt(html, lt);
    if (!name) {
      // 這個 `<` 是文字的一部分（`a < b`）
      index = lt + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) {
      // 引號沒關起來的壞標籤：剩下的全部當標記，不再猜（同 segment.js）
      flushText(lt);
      textStart = html.length;
      break;
    }

    flushText(lt);

    if (name.closing) {
      // 結束標籤把對應的開始標籤（以及中間沒關的）一起彈掉。
      // 找不到就當它不存在 —— 多一個 `</div>` 不該把 root 彈掉。
      // （`at > 0` 把 root 排除掉：root 的 tag 是 `#root`，不可能被配到）
      const at = stack.findLastIndex((node) => node.tag === name.tag);
      if (at > 0) stack = stack.slice(0, at);
      index = gt + 1;
      textStart = index;
      continue;
    }

    const node = makeNode(name.tag, attributesOf(html.slice(lt, gt + 1)));
    top().children.push(node);

    const selfClosing = html[gt - 1] === '/';

    if (OPAQUE_ELEMENTS.has(name.tag)) {
      // `<script>` / `<style>` 的內容裡有 `<` 也不是標籤，整段跳過。
      // 節點本身留著（它的屬性可能有用，例如 og:image 之類的 meta 旁邊）
      if (!selfClosing) {
        const closing = html.toLowerCase().indexOf(`</${name.tag}`, gt + 1);
        index = closing === -1 ? html.length : closing;
        textStart = index;
        continue;
      }
      index = gt + 1;
      textStart = index;
      continue;
    }

    if (!selfClosing && !VOID_ELEMENTS.has(name.tag) && stack.length < MAX_DEPTH) {
      stack = [...stack, node];
    }

    index = gt + 1;
    textStart = index;
  }

  flushText(html.length);

  return root;
}

module.exports = { parseDocument, isElement, OPAQUE_ELEMENTS, MAX_DEPTH };
