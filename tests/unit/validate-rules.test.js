'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRuleCreate,
  validateRuleUpdate,
  validateRuleOrder,
  validateResourcePath,
  validateResourceUpload,
} = require('../../src/lib/validate-rules.js');

const fieldsOf = (result) => result.errors.map((error) => error.field);

/* --------------------------------- 建立規則 -------------------------------- */

test('最小合法輸入：kind + pattern', () => {
  const result = validateRuleCreate({ kind: 'hide', pattern: '.tm-menu' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    kind: 'hide',
    pattern: '.tm-menu',
    replacement: '',
    scope: null,
    note: null,
    enabled: 1,
  });
});

test('三種 kind 都收，其他拒絕', () => {
  for (const kind of ['hide', 'text-replace', 'text-rewrite']) {
    assert.equal(validateRuleCreate({ kind, pattern: 'x' }).ok, true, kind);
  }
  assert.deepEqual(fieldsOf(validateRuleCreate({ kind: 'delete', pattern: 'x' })), ['kind']);
});

test('pattern 不能是空的、不能有換行、不能太長', () => {
  assert.deepEqual(fieldsOf(validateRuleCreate({ kind: 'hide', pattern: '' })), ['pattern']);
  assert.deepEqual(fieldsOf(validateRuleCreate({ kind: 'hide', pattern: 'a\nb' })), ['pattern']);
  assert.deepEqual(fieldsOf(validateRuleCreate({ kind: 'hide', pattern: 'x'.repeat(600) })), [
    'pattern',
  ]);
});

test('replacement 的空字串是合法的 —— 那是「把這段刪掉」', () => {
  const result = validateRuleCreate({ kind: 'text-rewrite', pattern: '-$', replacement: '' });

  assert.equal(result.ok, true);
  assert.equal(result.value.replacement, '');
});

test('scope 留空會變成 null（＝全站），空白字串也一樣', () => {
  assert.equal(validateRuleCreate({ kind: 'text-replace', pattern: 'a', scope: '' }).value.scope, null);
  assert.equal(validateRuleCreate({ kind: 'text-replace', pattern: 'a', scope: '  ' }).value.scope, null);
  assert.equal(
    validateRuleCreate({ kind: 'text-replace', pattern: 'a', scope: '#footer' }).value.scope,
    '#footer',
  );
});

test('⛔ 編譯不過的規則照樣存得起來 —— UI 要把它標紅，不是悄悄消失（規格 §4）', () => {
  const result = validateRuleCreate({ kind: 'text-rewrite', pattern: '(unclosed' });
  assert.equal(result.ok, true);
});

test('備註太長要擋（那是給人看的一行字，不是文件）', () => {
  assert.deepEqual(fieldsOf(validateRuleCreate({ kind: 'hide', pattern: '.a', note: 'x'.repeat(300) })), [
    'note',
  ]);
});

test('不是物件就直接退', () => {
  assert.equal(validateRuleCreate(null).ok, false);
  assert.equal(validateRuleCreate([]).ok, false);
});

/* --------------------------------- 更新規則 -------------------------------- */

test('更新只挑有帶的欄位', () => {
  const result = validateRuleUpdate({ enabled: false });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { enabled: 0 });
});

test('什麼都沒帶的更新是錯的（不然使用者會以為存好了）', () => {
  assert.equal(validateRuleUpdate({}).ok, false);
});

test('id / site_id 不能用更新改掉', () => {
  assert.deepEqual(fieldsOf(validateRuleUpdate({ id: 'x', enabled: true })), ['id']);
  assert.deepEqual(fieldsOf(validateRuleUpdate({ site_id: 'x', enabled: true })), ['site_id']);
});

/* ---------------------------------- 排序 ---------------------------------- */

test('排序要一串 id', () => {
  assert.deepEqual(validateRuleOrder({ ids: ['a', 'b'] }).value.ids, ['a', 'b']);
  assert.equal(validateRuleOrder({ ids: [] }).ok, false);
  assert.equal(validateRuleOrder({ ids: 'a,b' }).ok, false);
  assert.equal(validateRuleOrder({ ids: [1, 2] }).ok, false);
});

/* ------------------------------- 資源覆寫路徑 ------------------------------ */

test('路徑要以 / 開頭、不含 query 與 hash', () => {
  assert.equal(validateResourcePath('/images/logo.png').value, '/images/logo.png');
  assert.equal(validateResourcePath('images/logo.png').ok, false);
  assert.equal(validateResourcePath('/logo.png?v=2').ok, false);
  assert.equal(validateResourcePath('/logo.png#x').ok, false);
});

test('⛔ 路徑不能有 .. —— 那個字串會被拿去跟上游路徑比對，不要留想像空間', () => {
  assert.equal(validateResourcePath('/../etc/passwd').ok, false);
  assert.equal(validateResourcePath('/a/../b.png').ok, false);
});

test('⛔ 絕對網址與 protocol-relative 都不是「上游路徑」', () => {
  assert.equal(validateResourcePath('https://evil.test/x.png').ok, false);
  assert.equal(validateResourcePath('//evil.test/x.png').ok, false);
});

test('空的、太長的、有控制字元的路徑都拒絕', () => {
  assert.equal(validateResourcePath('').ok, false);
  assert.equal(validateResourcePath(`/${'x'.repeat(400)}`).ok, false);
  assert.equal(validateResourcePath('/a\nb.png').ok, false);
  assert.equal(validateResourcePath(null).ok, false);
});

/* -------------------------------- 上傳的檔案 ------------------------------- */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const GIF = Buffer.from('474946383961' + '00'.repeat(10), 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600' + '00'.repeat(10), 'hex');

test('點陣圖收得進來，而且 content-type 以「聞出來的」為準', () => {
  const result = validateResourceUpload(PNG, 'image/png');

  assert.equal(result.ok, true);
  assert.equal(result.value.content_type, 'image/png');
});

test('宣告跟內容不一致時以內容為準（宣告是使用者可控的字串）', () => {
  assert.equal(validateResourceUpload(GIF, 'image/png').value.content_type, 'image/gif');
  assert.equal(validateResourceUpload(JPEG, 'image/webp').value.content_type, 'image/jpeg');
});

test('⛔ SVG 一律拒絕 —— 它可以內嵌 script，而那張圖是從我們自己的 origin 送出去的', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

  const declared = validateResourceUpload(svg, 'image/svg+xml');
  assert.equal(declared.ok, false);
  assert.match(declared.errors[0].message, /SVG/);

  // 改個宣告也不行：內容照樣會被聞出來
  assert.equal(validateResourceUpload(svg, 'image/png').ok, false);
});

test('⛔ 聞不出來是點陣圖就拒絕（HTML 換個副檔名送上來也擋得住）', () => {
  assert.equal(validateResourceUpload(Buffer.from('<!doctype html><p>hi'), 'image/png').ok, false);
  assert.equal(validateResourceUpload(Buffer.from(''), 'image/png').ok, false);
});

test('太大的檔案拒絕', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
  assert.match(validateResourceUpload(big, 'image/png').errors[0].message, /最大/);
});
