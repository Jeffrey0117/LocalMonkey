'use strict';

/**
 * 「預先翻譯整站」（規格 §6）。
 *
 * ⛔ **這是在打別人的伺服器**，所以：同時只有 1 個請求、每個請求之間至少
 * 500ms。不要把這個功能變成壓測工具。
 *
 * 已經在 `translations` 裡的段會被 `enqueue` 跳過，所以重跑整站很便宜 ——
 * 只有新增 / 改過的文案要翻。
 */

const { fetchUpstreamPage } = require('../services/fetch-page.js');
const { collectCrawlTargets } = require('./crawl-links.js');
const { uniqueTexts } = require('./pipeline.js');
const { isUtf8Document } = require('./charset.js');
const { collectTranslatable } = require('../rules/no-translate.js');

const DEFAULTS = Object.freeze({
  startPath: '/',
  maxPages: 50,
  maxDepth: 3,
  politenessMs: 500,
});

const LIMITS = Object.freeze({ maxPages: 500, maxDepth: 10 });

/** 規格 §1 的實測值，UI 用它推估剩餘時間（這台實測熱的時候更快，約 118ms） */
const MS_PER_SEGMENT = 221;

class CrawlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrawlError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 把使用者給的參數夾進規格的上下限 */
function normalizeOptions({ startPath, maxPages, maxDepth } = {}) {
  const path = typeof startPath === 'string' && startPath.startsWith('/') ? startPath : DEFAULTS.startPath;

  return {
    startPath: path,
    maxPages: Math.min(
      Math.max(Number.isInteger(maxPages) ? maxPages : DEFAULTS.maxPages, 1),
      LIMITS.maxPages,
    ),
    maxDepth: Math.min(
      Math.max(Number.isInteger(maxDepth) ? maxDepth : DEFAULTS.maxDepth, 0),
      LIMITS.maxDepth,
    ),
  };
}

/** 進度 + 預估剩餘時間（規格 §6：UI 要顯示） */
function describeJob(job, queueStats) {
  const pending = queueStats?.pending ?? 0;

  return {
    ...job,
    pages_pending: Math.max(job.pages_found - job.pages_done, 0),
    segments_pending: pending,
    eta_ms: pending * MS_PER_SEGMENT,
  };
}

/**
 * @param {{
 *   store: object,
 *   config: object,
 *   logger: object,
 *   translation: object,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} context
 */
function createCrawler({ store, config, logger, translation, fetchImpl = fetch, sleepImpl = sleep }) {
  // 禮貌間隔（規格 §6：至少 500ms）。測試會把它調小，正式預設不要動。
  const politenessMs = config.translate?.crawlPolitenessMs ?? DEFAULTS.politenessMs;

  /**
   * 取消有沒有生效？**每一步都重讀 DB** —— 所以「取消」就只是一次 UPDATE，
   * 不需要跨模組的旗標或事件（規格 §6：中止要立刻生效）。
   */
  function isStopped(jobId) {
    return store.crawlJobs.get(jobId)?.status !== 'running';
  }

  function fetchPage(site, path) {
    return fetchUpstreamPage(site, path, {
      fetchImpl,
      allowPrivate: config.allowPrivate,
      timeoutMs: config.upstreamTimeoutMs,
    });
  }

  /** 一頁：切段 → 排進佇列 → 把佇列跑完（爬蟲的目的就是把它翻出來） */
  async function translatePage(site, html, contentType) {
    if (!isUtf8Document(html, contentType)) return 0;

    const active = translation.settingsFor(site);
    // ⛔ 跟請求路徑走同一支（`rules/no-translate.js`）。少接這一邊的後果是
    // 「頁面上省掉了，但按一次『預先翻譯整站』又把那 600 段全部塞回佇列」。
    const { items } = collectTranslatable(html, {
      store,
      siteId: site.id,
      glossary: active.glossary,
    });
    if (items.length === 0) return 0;

    const added = store.translateQueue.enqueue({
      texts: uniqueTexts(items),
      targetLang: active.targetLang,
      model: active.model,
      siteId: site.id,
    });

    await translation.queue.drain();
    return added;
  }

  async function run(site, jobId, options) {
    const frontier = [{ path: options.startPath, depth: 0 }];
    const seen = new Set([options.startPath]);

    store.crawlJobs.bump(jobId, { pages_found: 1 });

    let requests = 0;

    while (frontier.length > 0) {
      if (isStopped(jobId)) return;

      const { path, depth } = frontier.shift();

      // 禮貌：同時 1 個請求、間隔至少 500ms（第一個不等）
      if (requests > 0) await sleepImpl(politenessMs);
      if (isStopped(jobId)) return;

      requests += 1;

      try {
        const { html, contentType } = await fetchPage(site, path);

        if (html !== null) {
          if (isStopped(jobId)) return;

          const added = await translatePage(site, html, contentType);
          store.crawlJobs.bump(jobId, { segments_new: added });

          if (depth < options.maxDepth) {
            const discovered = collectCrawlTargets(html, {
              origin: site.target_origin,
              basePath: path,
            }).filter((next) => !seen.has(next));

            const room = options.maxPages - seen.size;
            for (const next of discovered.slice(0, Math.max(room, 0))) {
              seen.add(next);
              frontier.push({ path: next, depth: depth + 1 });
            }

            store.crawlJobs.bump(jobId, {
              pages_found: Math.min(discovered.length, Math.max(room, 0)),
            });
          }
        }
      } catch (error) {
        // 一頁掛掉不該讓整個工作失敗（連結壞了、上游 500、逾時都很常見）
        logger.warn(`爬 ${site.id}${path} 失敗：${error.message}`);
        store.crawlJobs.update(jobId, { last_error: `${path}：${error.message}`.slice(0, 500) });
      }

      store.crawlJobs.bump(jobId, { pages_done: 1 });
    }
  }

  /**
   * 開始爬。回 `{ job, done }` —— 路由只回 `job`（立刻），`done` 給測試與
   * 關機流程用。
   *
   * ⛔ 規格 §6：**啟動時要先確認 ollama 活著**，連不上就直接回錯誤，
   * 不要讓使用者按完等半天才發現。
   */
  async function start(site, input) {
    if (!site.translate_enabled) {
      throw new CrawlError(`${site.id} 的翻譯沒有打開，先開了再爬`);
    }

    const health = await translation.client.ping();
    if (!health.ok) {
      throw new CrawlError(`ollama 連不上，先把它叫起來：${health.error}`);
    }

    const options = normalizeOptions(input);
    const job = store.crawlJobs.create({
      site_id: site.id,
      start_path: options.startPath,
      max_pages: options.maxPages,
      max_depth: options.maxDepth,
    });

    const done = run(site, job.id, options)
      .then(() => {
        const current = store.crawlJobs.get(job.id);
        // 中途被取消的話狀態已經是 cancelled，不要蓋回 done
        if (current?.status === 'running') store.crawlJobs.update(job.id, { status: 'done' });
      })
      .catch((error) => {
        logger.error(`爬取工作 ${job.id} 掛了`, error);
        store.crawlJobs.update(job.id, {
          status: 'failed',
          last_error: String(error?.message ?? error).slice(0, 500),
        });
      })
      .then(() => store.crawlJobs.get(job.id));

    return { job, done };
  }

  function cancel(jobId) {
    const job = store.crawlJobs.get(jobId);
    if (!job) return null;
    if (job.status !== 'running') return job;

    return store.crawlJobs.update(jobId, { status: 'cancelled' });
  }

  return { start, cancel, describeJob, normalizeOptions };
}

module.exports = {
  createCrawler,
  normalizeOptions,
  describeJob,
  CrawlError,
  DEFAULTS,
  LIMITS,
  MS_PER_SEGMENT,
};
