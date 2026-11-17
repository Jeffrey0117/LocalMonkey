'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { startApp } = require('../support/app.js');
const { rawRequest } = require('../support/http.js');
const { PUBLIC_DIR } = require('../../src/routes/admin-page.js');

/**
 * 後台是瀏覽器端的程式，這裡測不到互動行為 —— 但可以測兩種會「整個壞掉卻無聲」
 * 的狀況：① 前端檔案語法錯誤 ② index.html 指到不存在的檔案。
 * 這兩個在沒有瀏覽器的環境下就是看不到，所以一定要有測試釘住。
 */

function publicScripts() {
  return fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(PUBLIC_DIR, name));
}

function referencedAssets() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const pattern = /(?:src|href)="(\/admin\/[^"]+)"/g;

  return [...html.matchAll(pattern)].map((match) => match[1]);
}

test('後台前端的每一支 JS 都是合法 JavaScript', () => {
  for (const file of publicScripts()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source), `${path.basename(file)} 語法有問題`);
  }
});

test('vendor 進來的 CodeMirror 是合法 JS，而且核心 / mode / addon 都串進去了', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'codemirror.js'), 'utf8');

  assert.doesNotThrow(() => new vm.Script(source));
  assert.ok(source.includes('defineMode("javascript"'), '少了 javascript mode');
  assert.ok(source.includes('matchBrackets'), '少了 matchbrackets addon');
  assert.ok(source.includes('autoCloseBrackets'), '少了 closebrackets addon');
  assert.ok(source.includes('styleActiveLine'), '少了 active-line addon');
});

test('CodeMirror 的授權檔跟著 vendor 進來了', () => {
  const license = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'CODEMIRROR-LICENSE.txt'), 'utf8');

  assert.ok(license.includes('MIT'), 'vendor 的程式碼要附授權');
  assert.ok(license.length > 500);
});

test('index.html 引用的每個 /admin/ 資源都真的送得出來', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const assets = referencedAssets();
  assert.ok(assets.length >= 8, `引用的資源太少，是不是漏了？${assets.join(', ')}`);

  for (const asset of assets) {
    const response = await rawRequest({
      port: app.port,
      path: asset,
      headers: { cookie: `lm_admin=${app.adminToken}` },
    });

    assert.equal(response.status, 200, `${asset} → ${response.status}`);
    assert.ok(response.body.length > 0, `${asset} 是空的`);
  }
});

test('/admin 回控制台的骨架（分頁、丟腳本、編輯器容器）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const response = await rawRequest({
    port: app.port,
    path: '/admin',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);

  for (const marker of [
    'data-tab="scripts"',
    'data-tab="sites"',
    'id="drop-open"',
    'id="editor"',
    'id="info-row"',
    'id="site-rows"',
    'id="drop-targets"',
    'id="delivery-url"',
    'id="delivery-rotate"',
    'id="version-hint"',
    'id="version-bump"',

    // v3：第一層是表格，點進去才是編輯器
    'id="list-view"',
    'id="script-rows"',
    'id="script-list-empty"',
    'id="editor-back"',
    'data-sort="name"',
    'data-sort="version"',
    'data-sort="size"',
    'data-sort="updatedAt"',
  ]) {
    assert.ok(response.text.includes(marker), `骨架少了 ${marker}`);
  }
});

test('後台的前端檔案一樣要 token（沒 token 連 JS 都拿不到）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  for (const asset of ['/admin/app.js', '/admin/api.js', '/admin/vendor/codemirror.js']) {
    const response = await rawRequest({ port: app.port, path: asset });
    assert.equal(response.status, 401, asset);
  }
});

test('前端沒有留 console.log（規格：要 log 就用後端的 logger）', () => {
  for (const file of publicScripts()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(
      /console\.log\(/.test(source),
      false,
      `${path.basename(file)} 裡有 console.log`,
    );
  }
});

test('前端不會從外部網域載任何東西（離線可用、不洩漏瀏覽行為）', () => {
  const files = [...publicScripts(), path.join(PUBLIC_DIR, 'index.html'), path.join(PUBLIC_DIR, 'app.css')];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const external = source.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g) ?? [];

    assert.deepEqual(external, [], `${path.basename(file)} 引用了外部資源`);
  }
});

/* ------------------------------ 版面回歸 ------------------------------ */

/**
 * 這幾條擋的是「只有真瀏覽器看得出來」的版面 bug。
 *
 * 用字串比對 CSS 當然比不上真的量 layout，但這兩個 bug 都有明確的成因，
 * 而成因是看得出來的：
 *   1. 用 hidden 當開關的元素被 CSS 的 display 蓋掉 → 永遠藏不住
 *   2. 三個子元素塞進兩欄的 grid 又沒指定列 → 第三個跑到左下角，而且高度不滿版
 *
 * 真的要驗 layout 得開瀏覽器，那個不值得為此進一個依賴（改完有在真瀏覽器量過）。
 */

function css() {
  return fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
}

/**
 * 取某個選擇器的規則內容。
 * 刻意用字串掃描而不是動態組 RegExp —— 選擇器裡有 `.` `[` `]` 這些字元，
 * 組 regex 要跳脫，而跳脫字元經過 shell / heredoc 很容易被吃掉（踩過）。
 */
function ruleFor(selector) {
  const text = css();
  const bodies = [];
  let from = 0;

  while (from < text.length) {
    const at = text.indexOf(selector, from);
    if (at === -1) break;

    const before = at === 0 ? '\n' : text[at - 1];
    const brace = text.indexOf('{', at + selector.length);
    const between = brace === -1 ? '' : text.slice(at + selector.length, brace);

    // 前面必須是換行、`}` 或 `,`（`html,\nbody` 這種選擇器清單也要算到）
    // 後面到 `{` 之間只能是空白或逗號（不然 `.editor-pane` 會配到 `.editor-pane .CodeMirror`）
    if ('\n},'.includes(before) && brace !== -1 && /^[\s,]*$/.test(between)) {
      const end = text.indexOf('}', brace);
      bodies.push(text.slice(brace + 1, end === -1 ? undefined : end));
      from = end === -1 ? text.length : end;
      continue;
    }

    from = at + selector.length;
  }

  // CSS 的階層是「所有命中規則的聯集」，所以全部串起來再斷言
  return bodies.length > 0 ? bodies.join('\n') : null;
}

test('⛔ [hidden] 有一條蓋得過 display 的規則（不然 hidden 開關全部失效）', () => {
  const rule = ruleFor('[hidden]');

  assert.ok(rule, 'app.css 要有 [hidden] 的規則');
  assert.match(rule, /display:\s*none/, '[hidden] 要設 display: none');
  assert.match(rule, /!important/, '要蓋得過元素自己的 display（作者樣式贏過 UA 樣式）');
});

test('⛔ 用 hidden 當開關、又自己設了 display 的元素，都靠上面那條救', () => {
  const togglesInHtml = fs
    .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .match(/id="([^"]+)"[^>]*\shidden/g) ?? [];

  assert.ok(togglesInHtml.length >= 3, `index.html 應該有多個 hidden 開關：${togglesInHtml.length}`);

  // 這些 class 都有 display，所以沒有 [hidden] 那條就會永遠顯示
  for (const selector of ['.editor-pane', '.info-row']) {
    assert.match(ruleFor(selector) ?? '', /display:/, `${selector} 有自己的 display`);
  }
});

test('⛔ 控制台的格線：單一列、可以縮，而且兩個 view 明確放在同一個格子', () => {
  const console = ruleFor('.console');

  assert.ok(console, '要有 .console 的規則');
  assert.match(console, /grid-template-rows:\s*minmax\(\s*0/, '列要寫明而且 min 是 0（才縮得下去）');

  // v3 是兩層（清單 / 編輯器）疊在同一個格子，靠 hidden 切換。
  // 兩個都要明確指定格子，不然第二個會被自動排到隱含的第二列（高度還會由內容決定）。
  for (const selector of ['.editor-pane', '.list-view']) {
    const rule = ruleFor(selector);
    assert.ok(rule, `要有 ${selector} 的規則`);
    assert.match(rule, /grid-column:\s*1/, `${selector} 要明確放在第一欄`);
    assert.match(rule, /grid-row:\s*1/, `${selector} 要明確放在第一列`);
    assert.match(rule, /min-height:\s*0/, 'flex/grid 子項預設 min-height:auto，內容會把容器撐開');
  }
});

test('⛔ 滿版高度：body 有 dvh、編輯器容器與 CodeMirror 都撐滿', () => {
  const body = ruleFor('body');

  assert.ok(body, '要有 body 的規則');
  assert.match(body, /height:\s*100dvh/, 'body 要用 100dvh（手機上才不會被工具列吃掉）');
  assert.match(css(), /html,\s*\n?body\s*\{[^}]*height:\s*100%/, '也要留 100% 當不支援 dvh 的退路');

  assert.match(ruleFor('main') ?? '', /min-height:\s*0/);
  assert.match(ruleFor('.editor-host') ?? '', /flex:\s*1/);
  assert.match(ruleFor('.editor-host') ?? '', /min-height:\s*0/);
  assert.match(css(), /\.editor-host\s+\.CodeMirror\s*\{[^}]*height:\s*100%/, 'CodeMirror 預設是固定高度，要蓋掉');
});

test('空狀態 pane 置中在編輯區裡（不是浮在頁面角落）', () => {
  const placeholder = ruleFor('.placeholder-pane');

  assert.match(placeholder, /align-items:\s*center/);
  assert.match(placeholder, /justify-content:\s*center/);
  assert.match(placeholder, /padding:/, '貼著邊緣很醜，要有 padding');
});

test('窄螢幕：站點與功能欄收起來（SPEC §2.3）', () => {
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css());

  assert.ok(narrow, '要有窄螢幕的 media query');
  assert.match(narrow[1], /\.col-sites,\s*\n?\s*\.col-features\s*\{[^}]*display:\s*none/);
});

/* --------------------------- v3：儀表板表格 --------------------------- */

test('表格要密（行高小）而且表頭吸頂', () => {
  assert.match(css(), /\.scripts-table th,\s*\n?\.scripts-table td\s*\{[^}]*padding:\s*5px/, '行高要小');
  assert.match(ruleFor('.scripts-table th') ?? '', /position:\s*sticky/, '捲動時表頭要留著');
});

test('可排序的表頭：游標是 pointer，目前排序欄顯示 ▲/▼', () => {
  const sortable = ruleFor('.scripts-table th.is-sortable');

  assert.ok(sortable, '要有可排序表頭的規則');
  assert.match(sortable, /cursor:\s*pointer/);
  assert.match(css(), /\[data-direction='asc'\]::after\s*\{[^}]*▲/);
  assert.match(css(), /\[data-direction='desc'\]::after\s*\{[^}]*▼/);
});

test('⛔ 停用的腳本整列轉灰（Tampermonkey 就是這樣，一眼看得出哪幾支沒在跑）', () => {
  assert.match(css(), /\.script-row\.is-disabled td\s*\{[^}]*opacity:/);
});

test('版本與大小用等寬字體（整欄才掃得過去）', () => {
  assert.match(ruleFor('.mono') ?? '', /font-family:[^;]*monospace/);
});

test('站點 favicon 有固定尺寸（不然圖片大小不一會把列撐歪）', () => {
  const favicon = ruleFor('.favicon');

  assert.ok(favicon, '要有 .favicon 的規則');
  assert.match(favicon, /width:\s*16px/);
  assert.match(favicon, /height:\s*16px/);
});

test('header 用 Tampermonkey 的深綠色系，其餘維持深色主題', () => {
  assert.match(ruleFor(':root') ?? '', /--header-bg:/, 'header 顏色要是 token');
  assert.match(ruleFor('.topbar') ?? '', /background:\s*var\(--header-bg\)/);
  // 不要把整個控制台翻成淺色 —— 使用者只說要「接近」那個儀表板的樣子
  assert.match(ruleFor('body') ?? '', /background:\s*var\(--bg\)/);
});
