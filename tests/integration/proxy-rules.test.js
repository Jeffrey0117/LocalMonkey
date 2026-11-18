'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');

/**
 * SPEC-rules §1：改造規則在真的代理上生效。
 *
 * 執行順序是規格的一部分：網址改寫 → 翻譯回填 → **文字規則** → hide 的 CSS
 * → 腳本注入。所以文字規則看到的是**翻譯後**的文字（`templatemo → templatee`
 * 不會被翻譯快取汙染，改規則立刻生效、不用重翻）。
 */

const PAGE = [
  '<!doctype html>',
  '<html lang="en"><head>',
  '<meta charset="utf-8">',
  '<link rel="stylesheet" href="/site.css">',
  '<title>templatemo</title>',
  '</head><body>',
  '<div class="templatemo-logo">',
  '<a href="https://templatemo.com"><img src="/images/templatemo-logo-new.png" alt="templatemo logo"></a>',
  '<h2 class="templatemo-slogan"> Free HTML CSS Website Templates</h2>',
  '</div>',
  '<div class="tm-menu"><a href="/page/1">Free Templates</a></div>',
  '<div class="thumbnail_270"><h2><a href="/tm-634">634 Lantern River</a></h2></div>',
  '<h1 class="title_2">620+ Free CSS Website Templates</h1>',
  '</body></html>',
].join('\n');

function htmlUpstream(body = PAGE) {
  return (req, res) => {
    const buffer = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length });
    res.end(buffer);
  };
}

async function scenario(t, { rules = [], upstream: handler } = {}) {
  const upstream = await startUpstream(handler ?? htmlUpstream());
  t.after(() => upstream.close());

  const app = await startApp();
  t.after(() => app.close());

  app.store.sites.create({
    id: 'demo',
    name: 'demo',
    target_origin: upstream.origin,
    enabled: 1,
  });

  for (const rule of rules) app.store.siteRules.create('demo', rule);

  const fetchPage = async (pathname = '/p/demo/') => {
    const response = await fetch(`${app.base}${pathname}`);
    return { response, text: await response.text() };
  };

  return { app, upstream, fetchPage };
}

/* --------------------------------- 沒有規則 -------------------------------- */

test('沒有任何規則 → HTML 原封不動，也不注入 style', async (t) => {
  const { fetchPage } = await scenario(t);
  const { text } = await fetchPage();

  assert.ok(text.includes('<h2 class="templatemo-slogan"> Free HTML CSS Website Templates</h2>'));
  assert.ok(!text.includes('lm-site-rules'));
});

/* ---------------------------------- hide ---------------------------------- */

test('hide 規則變成注入在 </head> 之前的 CSS', async (t) => {
  const { fetchPage } = await scenario(t, { rules: [{ kind: 'hide', pattern: '.tm-menu' }] });
  const { text } = await fetchPage();

  assert.match(text, /<style id="lm-site-rules">[\s\S]*\.tm-menu \{ display: none !important; \}/);
  assert.match(text, /<\/style>\s*<\/head>/);
  // 元素本身還在（我們藏的是視覺，不是改結構）
  assert.ok(text.includes('<div class="tm-menu">'));
});

test('停用的規則不生效', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'hide', pattern: '.tm-menu', enabled: 0 }],
  });

  assert.ok(!(await fetchPage()).text.includes('lm-site-rules'));
});

test('⛔ 選擇器寫壞（有大括號）→ 不注入那條，代理照常回 200', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'hide', pattern: 'a} body' }, { kind: 'hide', pattern: '.tm-menu' }],
  });

  const { response, text } = await fetchPage();

  assert.equal(response.status, 200);
  assert.match(text, /\.tm-menu \{ display: none/);
  assert.ok(!text.includes('a} body'));
});

/* ------------------------------- 文字規則 -------------------------------- */

test('text-replace 改文字、改 alt，但不准動 href / src / class', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'text-replace', pattern: 'templatemo', replacement: 'templatee' }],
  });

  const { text } = await fetchPage();

  assert.ok(text.includes('<title>templatee</title>'));
  assert.ok(text.includes('alt="templatee logo"'));
  assert.ok(text.includes('href="https://templatemo.com"'), 'href 不准被動到');
  assert.ok(text.includes('class="templatemo-logo"'), 'class 不准被動到');
  assert.ok(
    text.includes('src="/p/demo/images/templatemo-logo-new.png"'),
    'src 不准被動到（只有代理前綴那層改寫）',
  );
});

test('標語換成新文案（前面那個半形空白要留著）', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      {
        kind: 'text-replace',
        pattern: 'Free HTML CSS Website Templates',
        replacement: '超級齊全的 HTML CSS 網站模板',
      },
    ],
  });

  const { text } = await fetchPage();

  assert.ok(text.includes('<h2 class="templatemo-slogan"> 超級齊全的 HTML CSS 網站模板</h2>'));
  // h1 裡的 `620+ Free CSS Website Templates` 不含這個片語，不該被動到
  assert.ok(text.includes('620+ Free CSS Website Templates'));
});

test('text-rewrite + scope：只有卡片標題變成「名稱[編號]」', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      {
        kind: 'text-rewrite',
        pattern: '^(\\d{2,4})\\s+(.+)$',
        replacement: '$2[$1]',
        scope: '.thumbnail_270 h2',
      },
    ],
  });

  const { text } = await fetchPage();

  assert.ok(text.includes('>Lantern River[634]<'));
  assert.ok(text.includes('>620+ Free CSS Website Templates<'));
});

test('⛔ 正則編譯失敗 → 那條被跳過，其他規則照跑，不會 500', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      { kind: 'text-rewrite', pattern: '(unclosed', replacement: 'x', order_index: 0 },
      { kind: 'text-replace', pattern: 'templatemo', replacement: 'templatee', order_index: 1 },
    ],
  });

  const { response, text } = await fetchPage();

  assert.equal(response.status, 200);
  assert.ok(text.includes('<title>templatee</title>'));
});

test('規則命中數會回在 x-lm-rules header 上（除錯用）', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      { kind: 'text-replace', pattern: 'templatemo', replacement: 'templatee' },
      { kind: 'hide', pattern: '.tm-menu' },
    ],
  });

  const { response } = await fetchPage();

  assert.match(response.headers.get('x-lm-rules'), /hide=1/);
  assert.match(response.headers.get('x-lm-rules'), /text=[1-9]/);
});

/* --------------------------------- 邊界 ---------------------------------- */

test('非 HTML 的回應完全不經過規則層', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'text-replace', pattern: 'templatemo', replacement: 'templatee' }],
    upstream: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('.templatemo { color: red }');
    },
  });

  const { text } = await fetchPage('/p/demo/site.css');
  assert.equal(text, '.templatemo { color: red }');
});

test('⛔ 沒宣告 UTF-8 的頁面不套文字規則（插進去會變亂碼），但 hide 照舊', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      { kind: 'text-replace', pattern: 'templatemo', replacement: 'templatee' },
      { kind: 'hide', pattern: '.tm-menu' },
    ],
    upstream: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>templatemo</title></head><body>templatemo</body></html>');
    },
  });

  const { text } = await fetchPage();

  assert.ok(text.includes('<title>templatemo</title>'), '文字規則要跳過');
  assert.match(text, /\.tm-menu \{ display: none/, 'hide 的 CSS 是純 ASCII，照樣注入');
});

test('規則層與翻譯層的順序：文字規則看到的是翻譯後的文字', async (t) => {
  const upstream = await startUpstream(htmlUpstream());
  t.after(() => upstream.close());

  const client = {
    model: 'fake',
    batchSize: 20,
    async translateBatch(texts) {
      return texts.map((text) => (text === 'Free Templates' ? '免費模版' : `譯:${text}`));
    },
    async listModels() {
      return ['fake'];
    },
    async ping() {
      return { ok: true, models: ['fake'], error: null };
    },
  };

  const app = await startApp({ translationClient: client });
  t.after(() => app.close());

  app.store.sites.create({ id: 'demo', name: 'demo', target_origin: upstream.origin, enabled: 1 });
  app.store.sites.update('demo', { translate_enabled: 1, translate_lang: 'zh-TW' });
  // 規則認的是**譯文**裡的字
  app.store.siteRules.create('demo', {
    kind: 'text-replace',
    pattern: '免費模版',
    replacement: '模板總覽',
  });

  await fetch(`${app.base}/p/demo/`);
  await app.translation.queue.idle();

  const text = await (await fetch(`${app.base}/p/demo/`)).text();

  assert.ok(text.includes('模板總覽'), '規則要套在譯文上');
  assert.ok(!text.includes('免費模版'));
});

test('翻譯進度會回在 x-lm-translate header 上（規格 §5.2）', async (t) => {
  const upstream = await startUpstream(htmlUpstream());
  t.after(() => upstream.close());

  const app = await startApp({
    translationClient: {
      model: 'fake',
      batchSize: 20,
      async translateBatch(texts) {
        return texts.map((text) => `譯:${text}`);
      },
      async listModels() {
        return ['fake'];
      },
      async ping() {
        return { ok: true, models: ['fake'], error: null };
      },
    },
  });
  t.after(() => app.close());

  app.store.sites.create({ id: 'demo', name: 'demo', target_origin: upstream.origin, enabled: 1 });
  app.store.sites.update('demo', { translate_enabled: 1 });

  const first = await fetch(`${app.base}/p/demo/`);
  assert.match(first.headers.get('x-lm-translate'), /^0\/\d+$/, '第一次全部沒命中');

  await app.translation.queue.idle();

  const second = await fetch(`${app.base}/p/demo/`);
  const [hits, total] = second.headers.get('x-lm-translate').split('/').map(Number);
  assert.ok(hits > 0 && hits === total, `第二次應該全部命中，拿到 ${hits}/${total}`);
});

test('翻譯沒開的站不要帶 x-lm-translate（那個 header 在說「翻了幾段」）', async (t) => {
  const { fetchPage } = await scenario(t);
  const { response } = await fetchPage();

  assert.equal(response.headers.get('x-lm-translate'), null);
});

/* ------------------------------ css 規則（§9） ------------------------------ */

test('css 規則的內容原樣進注入的 <style>', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'css', pattern: '.tm_banner { margin: 0 !important; height: 0 !important; }' }],
  });

  const { text } = await fetchPage();
  assert.match(text, /<style id="lm-site-rules">[\s\S]*\.tm_banner \{ margin: 0 !important/);
});

test('hide 與 css 共用同一個 <style>（只注入一個）', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      { kind: 'hide', pattern: '.tm-menu' },
      { kind: 'css', pattern: '.templatemo-logo{height:0}' },
    ],
  });

  const { text } = await fetchPage();

  assert.equal(text.match(/<style id="lm-site-rules">/g).length, 1);
  assert.match(text, /\.tm-menu \{ display: none !important; \}/);
  assert.match(text, /\.templatemo-logo\{height:0\}/);
});

test('多行 CSS 的換行留著（textarea 貼進來的就是多行）', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'css', pattern: '.a {\n  margin: 0;\n}' }],
  });

  assert.match((await fetchPage()).text, /\.a \{\n {2}margin: 0;\n\}/);
});

test('CSS 裡的中文跳脫成 \\XXXXXX（頁面可能宣告任何 charset）', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [{ kind: 'css', pattern: '.templatemo-logo::after{content:"預覽"}' }],
  });

  const { text } = await fetchPage();
  // ⛔ 正則裡要寫兩個反斜線 —— `\0` 在正則裡是 NUL 字元，不是「反斜線加 0」
  assert.match(text, /content:"\\009810\\0089bd"/);
});

/**
 * ⛔ 這是 `css` 型別唯一真正危險的地方：使用者寫的字會原樣進 `<style>`，
 * 而 `<style>` 的內容對 HTML 分詞器來說是 raw text —— 唯一的出口是 `</style`。
 *
 * 這條測試看的是**送出去的 HTML 裡沒有多出一個 script tag**，而不是
 * 「API 有沒有回 400」：規格 §4 要求壞規則存得起來（UI 標紅），所以防線一定
 * 得在注入那一側。
 */
test('⛔ 含 </style> 的 css 規則不會變成 HTML 注入', async (t) => {
  const { fetchPage } = await scenario(t, {
    rules: [
      { kind: 'css', pattern: '.a{}</style><script>window.__pwned=1</script><style>' },
      { kind: 'css', pattern: '.safe{margin:0}' },
    ],
  });

  const { text } = await fetchPage();

  assert.equal(text.includes('__pwned'), false, '整條 CSS 不該出現在頁面上');
  assert.equal(text.match(/<style/g).length, 1, '只准有我們自己那一個 <style>');
  assert.equal(text.match(/<\/style>/g).length, 1);
  assert.match(text, /\.safe\{margin:0\}/, '壞的那一條不該連坐好的那一條');
});

test('css 規則停用就不注入；壞掉的規則在 API 列表上帶著 error', async (t) => {
  const { app, fetchPage } = await scenario(t, {
    rules: [
      { kind: 'css', pattern: '.off{margin:0}', enabled: 0 },
      { kind: 'css', pattern: '.b{}</style>' },
    ],
  });

  const { text } = await fetchPage();
  assert.equal(text.includes('.off'), false);

  const listed = await fetch(`${app.base}/admin/api/sites/demo/rules`, {
    headers: { authorization: `Bearer ${app.adminToken}` },
  }).then((response) => response.json());

  assert.match(listed.rules.find((rule) => rule.pattern.includes('</style>')).error, /style/);
});
