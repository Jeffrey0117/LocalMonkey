'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { PRESETS, applyPreset } = require('../../src/rules/presets/index.js');
const { translationHash } = require('../../src/translate/cache.js');

/**
 * SPEC-rules §3 / §6：**templatemo 的整組規則跑一次，逐條對照那張表**。
 *
 * 上游是 `tests/fixtures/templatemo/` 裡 2026-11-18 真的抓下來的三頁
 * （一個 byte 都沒改）。拿真頁面測的價值在這次就看得到：
 *
 * - 詳情頁有兩個元素共用 `id="tm-download"`，自己編的測資不會長這樣
 * - footer 的 ` - ` 是純文字節點，自己編的測資會寫成 `<span> - </span>`
 * - 首頁的卡片標題沒有編號，`/page/1` 的才有
 */

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'templatemo');

const PAGES = Object.freeze({
  '/': 'home.html',
  '/page/1': 'page-1.html',
  '/tm-634-lantern-river': 'tm-634-lantern-river.html',
});

const MODEL = 'qwen2.5:latest';
const LANG = 'zh-TW';

/** 使用者快取裡實際有的那幾段（規格 §3 的中文規則對著這些跑） */
const TRANSLATED = Object.freeze({
  // ⛔ 譯文**自己**前面有一個半形空白（模型加的）。字面比對要容忍它，
  //    所以規則的 pattern 不含空白，靠 splitEdges 把它留在 lead 裡
  'Free HTML CSS Website Templates': ' 免費 HTML CSS 網站模板',
  'Live View': '實時預覽',
  Download: '下載',
  // ⛔ footer 的這一段**連著前後的 ` - `** 都是同一個文字節點，所以快取的 key
  //    長這樣，譯文也連著分隔符 —— 孤兒分隔符那條規則要對這個收尾
  '- Free HTML CSS Website Templates Since 2008 -':
    '- 自2008年起提供免費HTML CSS網站模板 -',
  About: '關於',
  'Privacy Policy': '隱私政策',
  Contact: '聯絡我們',
  'XML Sitemap': 'XML 網站地圖',
  'Online Timer': '在線計時器',
  'Full-size Screenshot': '全尺寸截圖',
  'Lantern River': '燈河',
  '634 Lantern River': '634 燈河',
});

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function fixtureUpstream() {
  return (req, res) => {
    const name = PAGES[req.url];
    if (!name) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not in fixtures');
      return;
    }

    const buffer = Buffer.from(fixture(name), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length });
    res.end(buffer);
  };
}

function seedTranslations(store) {
  for (const [source, translated] of Object.entries(TRANSLATED)) {
    store.translations.put({
      hash: translationHash(source, LANG, MODEL),
      source_text: source,
      target_lang: LANG,
      model: MODEL,
      translated,
      origin: 'machine',
    });
  }
}

/** 假 ollama：這組測試不該真的去翻東西，沒命中的段保留原文就好 */
function idleClient() {
  return {
    model: MODEL,
    batchSize: 20,
    async translateBatch(texts) {
      return texts.map((text) => text);
    },
    async listModels() {
      return [MODEL];
    },
    async ping() {
      return { ok: true, models: [MODEL], error: null };
    },
  };
}

async function scenario(t, { translate = false } = {}) {
  const upstream = await startUpstream(fixtureUpstream());
  t.after(() => upstream.close());

  const app = await startApp({ translationClient: idleClient() });
  t.after(() => app.close());

  app.store.sites.create({
    id: 'templatemo-com',
    name: 'templatemo',
    target_origin: upstream.origin,
    enabled: 1,
  });

  if (translate) {
    app.store.sites.update('templatemo-com', { translate_enabled: 1, translate_lang: LANG, translate_model: MODEL });
    seedTranslations(app.store);
  }

  const applied = applyPreset(app.store, 'templatemo-com', PRESETS['templatemo-com']);

  const get = async (pathname) => {
    const response = await fetch(`${app.base}/p/templatemo-com${pathname}`);
    return { response, text: await response.text() };
  };

  return { app, upstream, applied, get };
}

/** 注入的 `<style id="lm-site-rules">` 裡面那一份 CSS */
function injectedCss(html) {
  return /<style id="lm-site-rules">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
}

/* --------------------------------- preset --------------------------------- */

test('preset 配得起來，而且每一條都編得過（沒有一條標紅）', async (t) => {
  const { app, applied } = await scenario(t);

  assert.equal(applied.created, PRESETS['templatemo-com'].length);

  assert.equal(
    app.store.siteRules.listBySite('templatemo-com').length,
    PRESETS['templatemo-com'].length,
  );

  // 清單端點會把編譯錯誤一起帶出來（規格 §4：壞掉的那一列要標紅）
  const rules = await fetch(`${app.base}/admin/api/sites/templatemo-com/rules`, {
    headers: { authorization: `Bearer ${app.adminToken}` },
  }).then((response) => response.json());

  assert.deepEqual(
    rules.rules.filter((rule) => rule.error).map((rule) => [rule.pattern, rule.error]),
    [],
  );
});

test('preset 是冪等的：跑第二次不會長出第二份', async (t) => {
  const { app } = await scenario(t);

  const second = applyPreset(app.store, 'templatemo-com', PRESETS['templatemo-com']);

  assert.deepEqual(second, { created: 0, updated: 0 });
  assert.equal(app.store.siteRules.listBySite('templatemo-com').length, PRESETS['templatemo-com'].length);
});

/* ------------------------------- §3.1 首頁 header ------------------------------- */

test('§3.1 標語改成「超級齊全的 HTML CSS 網站模板」（還沒翻到的狀態）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  // 原文沒有前導空白（那個空白是譯文自己帶的），所以這裡也不該有
  assert.match(text, /<h2 class="templatemo-slogan">超級齊全的 HTML CSS 網站模板<\/h2>/);
  // ⛔ 同一個片語也在 <title> 裡，不准被連坐
  assert.match(text, /<title>Download 620\+ Free HTML CSS Website Templates \| Templatee 2026<\/title>/);
});

test('§3.1 標語改成「超級齊全的…」（翻譯過的狀態）', async (t) => {
  const { get } = await scenario(t, { translate: true });
  const { text } = await get('/');

  assert.match(text, /<h2 class="templatemo-slogan"> 超級齊全的 HTML CSS 網站模板<\/h2>/);
});

test('§3.1 右邊四顆按鈕藏掉（元素還在，是視覺藏起來）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  assert.match(injectedCss(text), /^\.tm-menu \{ display: none !important; \}$/m);
  assert.ok(text.includes('<div class="tm-menu">'));
});

/* ------------------------------ §3.2 卡片標題 ------------------------------ */

test('§3.2 /page/1 的卡片標題變成「名稱[編號]」', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/page/1');

  assert.match(text, />Lantern River\[634\]</);
  assert.match(text, />Celadon\[633\]</);
  // 頁面標題（620+ Free CSS Website Templates）開頭也是數字，不准被改
  assert.match(text, /<h1 class="title_2">620\+ Free CSS Website Templates<\/h1>/);
});

test('§3.2 翻譯過也成立：634 燈河 → 燈河[634]', async (t) => {
  const { get } = await scenario(t, { translate: true });
  const { text } = await get('/page/1');

  assert.match(text, />燈河\[634\]</);
});

/**
 * ⛔ 這條是開真瀏覽器才抓到的：詳情頁底下那排「More Website Templates」用的
 * 容器是 `.tm_silver_360`，不是清單頁的 `.thumbnail_270`。只配前者的話，
 * 清單頁是對的、詳情頁卻看得到沒改過的標題 —— curl 與單元測試都不會發現，
 * 因為它們不會「順手往下滑一頁」。
 */
test('§3.2 詳情頁底下的相關模板也要改（容器 class 跟清單頁不一樣）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/tm-634-lantern-river');

  assert.match(text, />Celadon\[633\]</);
  assert.match(text, />Helix Drift\[630\]</);
  assert.ok(!text.includes('>633 Celadon<'), '還有沒改到的標題');
  // 區塊的標題（More Website Templates）不是卡片，不准被動到
  assert.match(text, /<h2 class="title_2">More Website Templates<\/h2>/);
});

test('§3.2 首頁的卡片沒有編號 → 規則不該亂動它', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  assert.match(text, />Lantern River</);
  assert.ok(!text.includes('Lantern River['));
});

/* ----------------------------- §3.3 詳情頁按鈕 ----------------------------- */

test('§3.3 只留下載與預覽，其餘五顆藏掉', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/tm-634-lantern-river');

  const css = injectedCss(text);

  // ⛔ 留下來的那兩顆的選擇器不准出現在 CSS 裡
  for (const hidden of [
    'a[href*="/screenshots/"]',
    'a[href*="ltcclock.com"]',
    'a[href*="tooplate.com"]',
    'a[href*="timermo.com"]',
    'a[href*="ai-website-prompt-generator"]',
  ]) {
    assert.ok(css.includes(hidden), `少了 ${hidden}`);
  }

  assert.ok(!css.includes('#tm-download'), '下載按鈕跟 AI 那顆共用 id，不准用 id 當選擇器');
  assert.ok(!css.includes('#tm-view'), '預覽要留著');
  assert.ok(!/\/download\//.test(css), '下載要留著');
});

test('⛔ §3.3 兩個元素共用 id="tm-download"：藏 AI 那顆不准連坐真的下載按鈕', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/tm-634-lantern-river');

  // fixture 本身就長這樣（這條順便釘住「fixture 沒被整理過」）
  assert.equal(text.match(/id="tm-download"/g).length, 3, 'fixture 裡有三處（含一處註解）');

  const css = injectedCss(text);
  assert.ok(css.includes('a[href*="ai-website-prompt-generator"]'));
  assert.ok(!css.includes('#tm-download'));
});

test('§3.3 實時預覽 → 預覽（翻譯過的狀態）', async (t) => {
  const { get } = await scenario(t, { translate: true });
  const { text } = await get('/tm-634-lantern-river');

  assert.match(text, /<a id="tm-view"[^>]*>預覽<\/a>/);
});

test('§3.3 Live View → 預覽（還沒翻到的狀態）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/tm-634-lantern-river');

  assert.match(text, /<a id="tm-view"[^>]*>預覽<\/a>/);
});

/* -------------------------------- §3.4 Footer -------------------------------- */

test('§3.4 五個連結藏掉', async (t) => {
  const { get } = await scenario(t);
  const css = injectedCss((await get('/')).text);

  for (const hidden of [
    '#footer a[href*="/about"]',
    '#footer a[href*="/privacy-policy"]',
    '#footer a[href*="/contact"]',
    '#footer a[href*="sitemap"]',
    'a[href*="timermo.com"]',
  ]) {
    assert.ok(css.includes(hidden), `少了 ${hidden}`);
  }
});

test('⛔ §3.4 藏完不准剩下孤兒的 - 分隔符（CSS 藏不掉純文字節點）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  const footer = /<div id="footer">([\s\S]*?)<\/div>/.exec(text)?.[1];
  assert.ok(footer, '要找到 footer');

  // 把被藏起來的連結整個拿掉之後，剩下的「看得見的文字」不該有 -
  const visible = footer.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, (anchor) =>
    /href="(?:\/p\/templatemo-com)?\/(?:about|privacy-policy|contact|sitemap)|timermo\.com/.test(anchor)
      ? ''
      : anchor,
  );
  const plain = visible.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  assert.equal(plain, '&copy; 2026 Templatee - Free HTML CSS Website Templates Since 2008');
  assert.ok(!/-\s*-/.test(plain), `還有連續的分隔符：${plain}`);
  assert.ok(!/-\s*$/.test(plain), `尾巴還有孤兒分隔符：${plain}`);
});

test('§3.4 翻譯過的 footer 也乾淨', async (t) => {
  const { get } = await scenario(t, { translate: true });
  const { text } = await get('/');

  const footer = /<div id="footer">([\s\S]*?)<\/div>/.exec(text)[1];
  const visible = footer.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, (anchor) =>
    /href="(?:\/p\/templatemo-com)?\/(?:about|privacy-policy|contact|sitemap)|timermo\.com/.test(anchor)
      ? ''
      : anchor,
  );
  const plain = visible.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  assert.equal(plain, '&copy; 2026 Templatee - 自2008年起提供免費HTML CSS網站模板');
});

/* ----------------------------- §3.5 全站文字替換 ----------------------------- */

test('§3.5 templatemo → templatee，大小寫風格跟著原文', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  assert.match(text, /<title>[^<]*Templatee 2026<\/title>/);
  assert.match(text, /alt="templatee free css templates"/);
  assert.match(text, /title="templatee - free templates"/);
  assert.match(text, />Templatee<\/a>/, 'footer 的 TemplateMo → Templatee');
});

test('⛔ §3.5 href / src / class / id 一個都不准被動到（規格 §6 的回歸保護）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  assert.match(text, /href="https:\/\/templatemo\.com"/, 'footer 的 href');
  assert.match(text, /class="templatemo-logo"/);
  assert.match(text, /class="templatemo-slogan"/);
  assert.match(text, /id="templatemo-container"/);
  assert.match(text, /src="\/p\/templatemo-com\/images\/templatemo-logo-new\.png"/);
  assert.match(text, /href="\/p\/templatemo-com\/tm-634-lantern-river"/);

  // `<base href>` 裡的 templatemo 也不准被換成 templatee。
  // （測試裡的上游是 127.0.0.1，所以這個 base 對代理來說是「別的網域」→
  //   照 lib/base-tag.js 的設計原樣保留；正式環境會被改寫成 /p/templatemo-com/）
  assert.match(text, /<base href="https:\/\/templatemo\.com\/"/);
});

test('⛔ §3.5 <script> 裡的字串不准被改（那是程式碼，不是文案）', async (t) => {
  const { get } = await scenario(t);
  const { text } = await get('/');

  assert.match(text, /dsh7ky7308k4b\.cloudfront\.net\/publishers\/templatemocom\.min\.js/);
});

/* ------------------------------ §3.6 資源覆寫 ------------------------------ */

test('§3.6 換掉 logo：首頁與詳情頁都拿到新的檔案，而且不碰上游', async (t) => {
  const { app, upstream, get } = await scenario(t);
  const { TEMPLATEMO_LOGO_PATH } = require('../../src/rules/presets/index.js');

  const replacement = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );

  const asset = app.store.assets.put({
    url: `lm://site/templatemo-com${TEMPLATEMO_LOGO_PATH}`,
    content: replacement,
    content_type: 'image/png',
  });
  app.store.resourceOverrides.put('templatemo-com', {
    path: TEMPLATEMO_LOGO_PATH,
    sha256: asset.sha256,
    content_type: 'image/png',
  });

  /**
   * 兩頁的 HTML 都還是指向同一條**路徑**，但會多一個內容雜湊
   * （v6 的 cache busting，SPEC-rules §8.1）—— 不加的話瀏覽器會吃上游給的
   * `max-age=604800`，換了 logo 七天內看不到。
   */
  const busted = `src="/p/templatemo-com/images/templatemo-logo-new.png?v=${asset.sha256.slice(0, 8)}"`;
  for (const pathname of ['/', '/tm-634-lantern-river']) {
    const { text } = await get(pathname);
    assert.ok(text.includes(busted), `${pathname} 的 logo 引用應該帶內容雜湊：${busted}`);
  }

  const before = upstream.received.length;
  const response = await fetch(`${app.base}/p/templatemo-com${TEMPLATEMO_LOGO_PATH}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  assert.ok(bytes.equals(replacement));
  assert.equal(response.headers.get('x-lm-resource-override'), '1');
  assert.equal(upstream.received.length, before);
});

/* --------------------------------- 整體 --------------------------------- */

test('整組規則跑完，頁面結構沒被弄壞（標籤數量不變）', async (t) => {
  const { get } = await scenario(t);

  for (const [pathname, name] of Object.entries(PAGES)) {
    const { text } = await get(pathname);
    const original = fixture(name);

    const count = (html, pattern) => (html.match(pattern) ?? []).length;

    // 我們只加了一個 <style>，其他標籤數量一個都不該變
    assert.equal(count(text, /<a\b/g), count(original, /<a\b/g), `${pathname} 的 <a>`);
    assert.equal(count(text, /<div\b/g), count(original, /<div\b/g), `${pathname} 的 <div>`);
    assert.equal(count(text, /<img\b/g), count(original, /<img\b/g), `${pathname} 的 <img>`);
    assert.equal(count(text, /<style\b/g), count(original, /<style\b/g) + 1, `${pathname} 的 <style>`);
  }
});

/**
 * ⛔ 數字從 preset 算，不要寫死：這組規則本來就會長（使用者會一直加），
 * 寫死的話每次加一條規則就要回來改測試，而那種「改一下數字就綠了」的測試
 * 很快就會被改到失去意義。
 */
test('規則命中數回在 x-lm-rules header 上', async (t) => {
  const { get } = await scenario(t);
  const { TEMPLATEMO_RULES } = require('../../src/rules/presets/index.js');
  const countOf = (kind) => TEMPLATEMO_RULES.filter((rule) => rule.kind === kind).length;

  const { response } = await get('/tm-634-lantern-river');

  assert.match(
    response.headers.get('x-lm-rules'),
    new RegExp(`hide=${countOf('hide')} css=${countOf('css')} text=\\d+`),
    response.headers.get('x-lm-rules'),
  );
});
