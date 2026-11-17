'use strict';

/**
 * 本機 ollama 的客戶端。
 *
 * ⛔ 這是伺服器**自己**發起的呼叫，不是使用者腳本發起的，所以**不走** SSRF 防護
 * （規格 §8）。ollama 一定在 localhost，而 `LOCALMONKEY_ALLOW_PRIVATE` 是代理
 * 目標的開關 —— 為了翻譯去打開它等於讓所有代理目標都能指向內網。兩件事要分開。
 *
 * 核心責任是**對齊防呆**：回來的東西對不上就整批丟棄、退回原文（見 parseBatchResult）。
 */

const { buildPrompt } = require('./prompt.js');

/**
 * `kind` 是給佇列用的分類，決定失敗之後要怎麼辦（見 queue.js）：
 *
 * | kind | 意思 | 佇列的反應 |
 * |---|---|---|
 * | `alignment`  | 模型**回了**，但對不上 | **二分重試**，單段也失敗才 `attempts += 1` |
 * | `timeout`    | 等太久，沒拿到回應 | 不二分、不燒 attempts、這一輪收手 |
 * | `unreachable`| 連不到 ollama | 同上 |
 * | `http`       | ollama 回 4xx/5xx | 同上（模型名稱打錯之類，二分也沒用） |
 *
 * ⛔ **只有「模型的答案錯了」才值得二分**，「沒拿到答案」不值得。
 * 逾時一次就要等 120 秒，遞迴二分 20 段會變成 39 次逾時 ＝ 一個多小時。
 * 而逾時最常見的原因是冷啟動 —— 收手、下一次 kick 時模型已經熱了就過了。
 *
 * ⛔ 「要不要二分」與「要不要燒掉那一段的重試額度」是**兩個不同的問題**。
 * 基礎設施壞掉時燒 attempts，等於 ollama 關一小時就把整站標成「翻不動」。
 */
class OllamaError extends Error {
  constructor(message, { kind = 'unreachable', ...options } = {}) {
    super(message, options);
    this.name = 'OllamaError';
    this.kind = kind;
  }
}

/** 對齊檢查沒過 —— 這是**內容**的問題，所以值得二分去找出是哪一段。 */
class AlignmentError extends OllamaError {
  constructor(message, { reason } = {}) {
    super(message, { kind: 'alignment' });
    this.name = 'AlignmentError';
    this.reason = reason ?? message;
  }
}

/** 模型**回了**但答案錯 → 拆小有機會找出是哪一段的問題。 */
function isBisectable(error) {
  return error?.kind === 'alignment';
}

/** 根本沒拿到答案 → 跟段落內容無關，不該算在那一段頭上，也不值得拆小重試。 */
function isInfrastructure(error) {
  return error?.kind === 'timeout' || error?.kind === 'unreachable' || error?.kind === 'http';
}

const DEFAULT_BATCH_SIZE = 20;

/** 模型常常自己包一層 ```json 圍籬，即使叫它不要 */
function stripCodeFence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/** 嚴格的 `"0"`、`"1"`…：`"00"`、`"0.0"`、`"-1"`、`"x"` 全部不算 */
function isIndexKey(key, count) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;

  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < count;
}

/**
 * ⛔⛔ 整個功能最危險的地方。
 *
 * 實測（規格 §1）：要求 JSON **陣列**時模型會回 object 而且**整批錯位** ——
 * 第一段的譯文被拿去當 key、value 變成第二段的譯文。錯位比翻錯危險得多，
 * 因為每一段看起來都「有翻」，不會有人發現，而且會被寫進永久快取。
 *
 * 所以：是 object、key 剛好是 `"0"`..`"n-1"`、每個 value 是非空字串 ——
 * **任何一條不符就整批丟棄**，絕不硬塞。
 *
 * @param {unknown} raw 模型回的字串
 * @param {number} count 這一批送了幾段
 * @returns {{ ok: true, texts: string[] } | { ok: false, reason: string }}
 */
function parseBatchResult(raw, count) {
  if (count === 0) return { ok: true, texts: [] };
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: '模型沒有回任何內容' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (cause) {
    return { ok: false, reason: `回應不是合法 JSON：${cause.message}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `回應必須是索引當 key 的物件，拿到的是${Array.isArray(parsed) ? '陣列' : typeof parsed}`,
    };
  }

  const keys = Object.keys(parsed);
  if (keys.length !== count) {
    return { ok: false, reason: `數量對不上：送了 ${count} 段，回來 ${keys.length} 段` };
  }
  if (!keys.every((key) => isIndexKey(key, count))) {
    return { ok: false, reason: `key 不是 0..${count - 1}：${keys.slice(0, 5).join(', ')}` };
  }

  const texts = Array.from({ length: count }, (unused, index) => parsed[String(index)]);
  const badAt = texts.findIndex((text) => typeof text !== 'string' || text.trim().length === 0);
  if (badAt !== -1) {
    return { ok: false, reason: `第 ${badAt} 段的譯文不是非空字串（${typeof texts[badAt]}）` };
  }

  return { ok: true, texts };
}

/**
 * 逾時雙保險。
 *
 * ⛔ `AbortSignal.timeout` 單獨用不夠：node 的 fetch 不保證理會 signal，
 * 注入的 fetch 更不保證（infra-map 記過這個坑 —— promise 永不 settle、
 * in-flight 旗標永遠占住、零診斷）。所以外面再包一層 `Promise.race`。
 *
 * ⛔ 那個計時器**不准 unref**：unref 的計時器在沒有別的事撐著 event loop
 * 時不會觸發，於是最該醒過來的時候正好不醒。
 */
async function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  const alarm = new Promise((unused, reject) => {
    timer = setTimeout(() => reject(new OllamaError(`${label} 逾時（${timeoutMs}ms）`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, alarm]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   keepAlive?: string,
 *   timeoutMs?: number,
 *   batchSize?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
function createOllamaClient({
  baseUrl,
  model,
  keepAlive = '30m',
  timeoutMs = 120_000,
  batchSize = DEFAULT_BATCH_SIZE,
  fetchImpl = fetch,
}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(pathname, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await withTimeout(
        fetchImpl(`${root}${pathname}`, {
          method,
          ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
        `ollama ${pathname}`,
      );
    } catch (cause) {
      if (cause instanceof OllamaError) throw cause;

      // ⛔ 逾時不是「連不上」。兩者的處理方式完全不同（一個是把 ollama 叫起來，
      //    一個是模型太慢 / 批次太大），訊息混在一起會讓人往錯的方向查 ——
      //    實測踩過：log 寫「連不到 ollama」，但 ollama 其實好好的，只是冷啟動慢。
      const timedOut = cause?.name === 'TimeoutError' || /abort|timeout/i.test(cause?.message ?? '');
      throw new OllamaError(
        timedOut
          ? `ollama 超過 ${timeoutMs}ms 還沒回應（${pathname}）—— 模型可能正在冷啟動，或這一批太大`
          : `連不到 ollama（${root}）：${cause.message}`,
        { cause, kind: timedOut ? 'timeout' : 'unreachable' },
      );
    }

    if (!response.ok) {
      throw new OllamaError(`ollama 回 HTTP ${response.status}（${pathname}）`, { kind: 'http' });
    }

    try {
      return await withTimeout(response.json(), timeoutMs, `ollama ${pathname} 讀取`);
    } catch (cause) {
      if (cause instanceof OllamaError) throw cause;
      throw new OllamaError(`ollama 的回應讀不出來：${cause.message}`, { cause, kind: 'http' });
    }
  }

  /** 控制台的模型下拉選單（規格 §7） */
  async function listModels() {
    const payload = await call('/api/tags');
    const models = Array.isArray(payload?.models) ? payload.models : [];

    return models
      .map((entry) => (typeof entry?.name === 'string' ? entry.name : null))
      .filter((name) => name !== null);
  }

  /** 活著嗎？**不丟錯** —— 這個答案要能直接放進 UI 與健檢。 */
  async function ping() {
    try {
      return { ok: true, models: await listModels(), error: null };
    } catch (error) {
      return { ok: false, models: [], error: String(error?.message ?? error) };
    }
  }

  /**
   * 翻一批。超過 batchSize 要呼叫端自己切 —— 偷偷截斷就會悄悄少翻幾段。
   *
   * @param {string[]} texts
   * @param {{ targetLang?: string, glossary?: string[] }} [options]
   * @returns {Promise<string[]>} 與輸入同長度、同順序
   * @throws {AlignmentError} 對齊不上（呼叫端要整批退回原文）
   * @throws {OllamaError} 連不上 / 逾時 / HTTP 錯誤
   */
  async function translateBatch(texts, { targetLang, glossary = [] } = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (texts.length > batchSize) {
      throw new OllamaError(`一次最多 ${batchSize} 段（batchSize），拿到 ${texts.length} 段`, {
        kind: 'http',
      });
    }

    const payload = await call('/api/generate', {
      method: 'POST',
      body: {
        model,
        prompt: buildPrompt(texts, { targetLang, glossary }),
        format: 'json',
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0 },
      },
    });

    const result = parseBatchResult(payload?.response, texts.length);
    if (!result.ok) {
      throw new AlignmentError(`模型回的內容對不上，整批退回原文：${result.reason}`, {
        reason: result.reason,
      });
    }

    return result.texts;
  }

  return { translateBatch, listModels, ping, model, batchSize, baseUrl: root };
}

module.exports = {
  createOllamaClient,
  parseBatchResult,
  withTimeout,
  isBisectable,
  isInfrastructure,
  OllamaError,
  AlignmentError,
  DEFAULT_BATCH_SIZE,
};
