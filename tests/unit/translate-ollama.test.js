'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBatchResult,
  createOllamaClient,
  OllamaError,
  AlignmentError,
} = require('../../src/translate/ollama.js');

/**
 * 規格 §1 / §4 —— 這支測的是整個功能最危險的地方。
 *
 * ⛔ 實測：要求模型回 JSON **陣列**時它會整批錯位（第一段的翻譯被拿去當 key，
 * value 變成第二段的翻譯）。**錯位比翻錯危險得多**，因為每一段看起來都
 * 「有翻」，不會有人發現，而且會被寫進永久快取。
 *
 * 所以請求格式是「索引當 key 的 object」，而且**任何一條對不上就整批丟棄**。
 * 這些斷言做過退化驗證（把 parseBatchResult 的檢查拿掉，確認它們真的變紅）。
 */

/* --------------------------- 對齊防呆（純函式） --------------------------- */

test('正常情形：索引當 key 的 object，依序回陣列', () => {
  const result = parseBatchResult('{"0":"你好","1":"世界"}', 2);

  assert.deepEqual(result, { ok: true, texts: ['你好', '世界'] });
});

test('key 的順序顛倒也照索引對回去（JSON 的 key 沒有順序保證）', () => {
  const result = parseBatchResult('{"2":"丙","0":"甲","1":"乙"}', 3);

  assert.deepEqual(result.texts, ['甲', '乙', '丙']);
});

test('⛔ key 少一個 → 整批退回原文', () => {
  const result = parseBatchResult('{"0":"你好"}', 2);

  assert.equal(result.ok, false);
  assert.match(result.reason, /數量/);
});

test('⛔ key 多一個 → 整批退回原文', () => {
  const result = parseBatchResult('{"0":"你好","1":"世界","2":"多的"}', 2);

  assert.equal(result.ok, false);
});

test('⛔ key 不是 0..n-1（跳號、負數、文字 key）→ 整批退回原文', () => {
  for (const raw of [
    '{"0":"a","2":"b"}',
    '{"1":"a","2":"b"}',
    '{"-1":"a","0":"b"}',
    '{"0":"a","x":"b"}',
    '{"00":"a","1":"b"}',
    '{"0.0":"a","1":"b"}',
  ]) {
    assert.equal(parseBatchResult(raw, 2).ok, false, raw);
  }
});

test('⛔ value 是數字 / null / 物件 / 陣列 → 整批退回原文', () => {
  for (const raw of [
    '{"0":"a","1":42}',
    '{"0":"a","1":null}',
    '{"0":"a","1":{"x":1}}',
    '{"0":"a","1":["b"]}',
    '{"0":"a","1":true}',
  ]) {
    assert.equal(parseBatchResult(raw, 2).ok, false, raw);
  }
});

test('⛔ value 是空字串或只有空白 → 整批退回原文（翻成空的會把版面清掉）', () => {
  assert.equal(parseBatchResult('{"0":"a","1":""}', 2).ok, false);
  assert.equal(parseBatchResult('{"0":"a","1":"   "}', 2).ok, false);
});

test('⛔ 模型回陣列（實測真的會發生）→ 整批退回原文', () => {
  assert.equal(parseBatchResult('["你好","世界"]', 2).ok, false);
  assert.match(parseBatchResult('["你好","世界"]', 2).reason, /物件|陣列/);
});

test('⛔ 實測的錯位長相：翻譯被拿去當 key → 整批退回原文', () => {
  // 第一段的譯文變成 key、value 是第二段的譯文。每一段「看起來都有翻」。
  const misaligned = '{"你好":"世界","世界":"再見"}';

  assert.equal(parseBatchResult(misaligned, 2).ok, false);
});

test('⛔ 不是 JSON / 空的 / 非字串 → 整批退回原文，而且不丟錯', () => {
  for (const raw of ['', '   ', 'not json', '{', null, undefined, 42, {}]) {
    const result = parseBatchResult(raw, 2);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(typeof result.reason, 'string');
  }
});

test('模型多包了一層 markdown code fence 時仍然解得出來（很常見）', () => {
  const fenced = '```json\n{"0":"你好","1":"世界"}\n```';

  assert.deepEqual(parseBatchResult(fenced, 2).texts, ['你好', '世界']);
});

test('count 為 0 時回空陣列（不要為了零段去呼叫模型）', () => {
  assert.deepEqual(parseBatchResult('{}', 0), { ok: true, texts: [] });
});

/* ------------------------------ 客戶端 ------------------------------ */

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(calls.length, { url, init });
  };
  return { impl, calls };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl, overrides = {}) {
  return createOllamaClient({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:latest',
    keepAlive: '30m',
    timeoutMs: 1_000,
    fetchImpl,
    ...overrides,
  });
}

test('translateBatch：打 /api/generate，帶 format json / temperature 0 / keep_alive', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ response: '{"0":"你好"}' }));
  const client = clientWith(impl);

  assert.deepEqual(await client.translateBatch(['Hello'], { targetLang: 'zh-TW' }), ['你好']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.model, 'qwen2.5:latest');
  assert.equal(calls[0].body.format, 'json');
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.options.temperature, 0);
  assert.equal(calls[0].body.keep_alive, '30m', '少了這個每隔一陣子就要再吃 45 秒冷啟動');
});

test('translateBatch：prompt 裡的原文是索引當 key 的 object', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ response: '{"0":"甲","1":"乙"}' }));
  const client = clientWith(impl);

  await client.translateBatch(['One', 'Two'], { targetLang: 'zh-TW' });

  assert.match(calls[0].body.prompt, /"0":\s*"One"/);
  assert.match(calls[0].body.prompt, /"1":\s*"Two"/);
});

test('⛔ 對齊不上就丟 AlignmentError（呼叫端要整批退回原文）', async () => {
  const { impl } = fakeFetch(() => jsonResponse({ response: '["甲","乙"]' }));
  const client = clientWith(impl);

  await assert.rejects(() => client.translateBatch(['One', 'Two'], { targetLang: 'zh-TW' }), AlignmentError);
});

test('空輸入不會發出請求', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ response: '{}' }));
  const client = clientWith(impl);

  assert.deepEqual(await client.translateBatch([], { targetLang: 'zh-TW' }), []);
  assert.equal(calls.length, 0);
});

test('⛔ 一次最多 batchSize 段（超過要呼叫端自己切，不准偷偷截斷）', async () => {
  const { impl } = fakeFetch(() => jsonResponse({ response: '{}' }));
  const client = clientWith(impl, { batchSize: 2 });

  await assert.rejects(
    () => client.translateBatch(['a', 'b', 'c'], { targetLang: 'zh-TW' }),
    /batchSize/,
  );
});

test('⛔ ollama 連不上 → OllamaError（代理不准因此掛掉）', async () => {
  const { impl } = fakeFetch(() => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  });
  const client = clientWith(impl);

  await assert.rejects(
    () => client.translateBatch(['Hello'], { targetLang: 'zh-TW' }),
    (error) => error instanceof OllamaError && /連不到/.test(error.message),
  );
});

test('⛔ 逾時的訊息不准寫成「連不上」（會害人往錯的方向查）', async () => {
  // 實測踩過（2026-11-18）：ollama 好好的、只是冷啟動慢，但 log 寫「連不到 ollama」
  const { impl } = fakeFetch(() => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  });
  const client = clientWith(impl);

  await assert.rejects(
    () => client.translateBatch(['Hello'], { targetLang: 'zh-TW' }),
    (error) =>
      error instanceof OllamaError && /沒回應/.test(error.message) && !/連不到/.test(error.message),
  );
});

test('⛔ HTTP 不是 2xx → OllamaError，訊息帶狀態碼', async () => {
  const { impl } = fakeFetch(() => jsonResponse({ error: 'model not found' }, 404));
  const client = clientWith(impl);

  await assert.rejects(
    () => client.translateBatch(['Hello'], { targetLang: 'zh-TW' }),
    (error) => error instanceof OllamaError && /404/.test(error.message),
  );
});

test('⛔ 逾時：AbortSignal 之外還要有 Promise.race（node 的 fetch 不保證理會 signal）', async () => {
  // 這個假 fetch 完全無視 signal，永遠不 resolve —— 就是規格警告的那種情形
  const neverSettles = () => new Promise(() => {});
  const client = clientWith(neverSettles, { timeoutMs: 60 });

  const started = Date.now();
  await assert.rejects(
    () => client.translateBatch(['Hello'], { targetLang: 'zh-TW' }),
    (error) => error instanceof OllamaError && /逾時/.test(error.message),
  );
  assert.ok(Date.now() - started < 3_000, '要靠自己的計時器醒過來，不能等到 node 想通');
});

test('⛔ 逾時的計時器不准 unref（unref 的計時器在沒別的事撐著時不會觸發）', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'translate', 'ollama.js'),
    'utf8',
  );

  assert.equal(/\.unref\(\)/.test(source), false, 'infra-map 記過這個坑');
});

test('listModels：從 /api/tags 撈模型清單（控制台的下拉選單用）', async () => {
  const { impl, calls } = fakeFetch(() =>
    jsonResponse({ models: [{ name: 'qwen2.5:latest' }, { name: 'llama3:8b' }] }),
  );
  const client = clientWith(impl);

  assert.deepEqual(await client.listModels(), ['qwen2.5:latest', 'llama3:8b']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
});

test('ping：活著回 ok、連不上回 ok:false + 原因（不丟錯）', async () => {
  const alive = clientWith(fakeFetch(() => jsonResponse({ models: [{ name: 'qwen2.5:latest' }] })).impl);
  assert.deepEqual(await alive.ping(), { ok: true, models: ['qwen2.5:latest'], error: null });

  const dead = clientWith(
    fakeFetch(() => {
      throw new Error('ECONNREFUSED');
    }).impl,
  );
  const result = await dead.ping();

  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
  assert.deepEqual(result.models, []);
});

test('baseUrl 結尾的斜線不會變成雙斜線', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ models: [] }));
  const client = clientWith(impl, { baseUrl: 'http://127.0.0.1:11434/' });

  await client.listModels();
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
});
