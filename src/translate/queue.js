'use strict';

/**
 * 背景翻譯佇列（規格 §4 / §5）。
 *
 * **序列化**：ollama 本來就不併行（一顆模型、一張顯卡），所以同時只有一條
 * 在跑。`kick()` 是射後不理（代理的請求路徑在呼叫它，不准 await、不准丟錯），
 * `drain()` 回 promise 給爬蟲與測試用。
 *
 * 失敗處理照規格 §4：**整批丟棄、退回原文、attempts += 1**。
 * `attempts >= MAX_ATTEMPTS` 的段不再重試 —— 標記成翻不動，UI 顯示出來
 * 讓人工處理，不要無限重試一直燒 CPU。
 */

const { isBisectable, isInfrastructure } = require('./ollama.js');

const MAX_ATTEMPTS = 3;

/**
 * @param {{
 *   store: object,
 *   client: { translateBatch: Function, model: string },
 *   logger: object,
 *   batchSize?: number,
 *   maxAttempts?: number,
 * }} context
 */
function createTranslationQueue({ store, client, logger, batchSize = 20, maxAttempts = MAX_ATTEMPTS }) {
  let running = null;
  let stopped = false;

  function remember(rows, translated) {
    // 寫入前再經過一次「manual 不准被覆蓋」的 SQL（db/translations.js）
    for (const [index, row] of rows.entries()) {
      store.translations.put({
        hash: row.hash,
        source_text: row.source_text,
        target_lang: row.target_lang,
        model: row.model,
        translated: translated[index],
        origin: 'machine',
      });
    }

    store.translateQueue.clear(rows.map((row) => row.hash));
  }

  /**
   * 翻一塊，**對不上就二分**。
   *
   * ⛔ 為什麼不是「固定批次、整批重試三次」：實測（2026-11-18 對真的 templatemo）
   * **20 段的批次，qwen2.5 回了 35 個 key**。規格的「批次 20」是從「10 段實測完美」
   * 外推的，那個外推錯了。固定批次的語意是「19 個好段被 1 個壞段連坐」——
   * 三輪之後那 19 段也一起被標成翻不動。
   *
   * 二分之後：20 → 2×10 → 4×5 → … → 單段。單段不可能數量對不上（送 1 回 1），
   * 所以一定收斂，而且**只有真的有問題的那幾段**會掉到慢速路徑。
   *
   * 基礎設施壞掉（連不到 / HTTP 錯）**不二分**：那跟段落內容無關，拆小只是多等
   * 幾次，而且要讓呼叫端整個收手。
   *
   * @returns {{ translated: number, failed: Array<object>, fatal: Error|null }}
   */
  async function translateChunk(rows) {
    try {
      const translated = await client.translateBatch(
        rows.map((row) => row.source_text),
        { targetLang: rows[0].target_lang, glossary: rows[0].glossary ?? [] },
      );

      remember(rows, translated);
      return { translated: rows.length, failed: [], fatal: null };
    } catch (error) {
      if (isInfrastructure(error)) {
        return { translated: 0, failed: rows, fatal: error };
      }

      // 已經縮到單段還是失敗 → 就是這一段有問題，記在它頭上
      if (rows.length === 1 || !isBisectable(error)) {
        return { translated: 0, failed: rows, fatal: null, error };
      }

      const middle = Math.ceil(rows.length / 2);
      const left = await translateChunk(rows.slice(0, middle));
      // 左半邊踩到基礎設施問題就別再試右半邊了（只會多等一次逾時）
      if (left.fatal) return { ...left, failed: [...left.failed, ...rows.slice(middle)] };

      const right = await translateChunk(rows.slice(middle));

      return {
        translated: left.translated + right.translated,
        failed: [...left.failed, ...right.failed],
        fatal: right.fatal,
        error: left.error ?? right.error,
      };
    }
  }

  /** 一批：claim → 翻（必要時二分）→ 寫快取 / 記失敗 */
  async function runBatch(rows) {
    const result = await translateChunk(rows);

    if (result.failed.length > 0) {
      const reason = result.fatal ?? result.error;

      // ⛔ 基礎設施壞掉不准燒掉段落的重試額度 —— 不然 ollama 關一小時，
      //    整站的段落都會被標成「翻不動」，而那跟段落本身一點關係都沒有。
      store.translateQueue.recordFailure(result.failed, reason?.message ?? reason, {
        countAttempt: !isInfrastructure(reason),
      });

      logger.warn(
        `翻譯失敗（${result.failed.length} 段退回原文）：${reason?.message ?? reason}`,
      );
    }

    return { translated: result.translated, failed: result.failed.length, fatal: result.fatal };
  }

  /**
   * 把佇列跑一輪。
   *
   * ⛔ 失敗的那批要記進 `tried` 並**繼續做下一批**，不能直接 break。
   * 實測（2026-11-18，整站 85 段）：ollama 冷啟動那一下逾時之後，舊的寫法
   * 直接跳出迴圈 → 85 段全部停在原地，控制台上「待翻 85」再也不會動，
   * 而且沒有任何錯誤訊息會再出現。一次暫時性的逾時不該讓整站停擺。
   *
   * `tried` 也擋掉「原地打轉」：claim 的排序固定，不排除剛失敗的那批就會
   * 一直拿到同一批。
   */
  async function loop() {
    const totals = { batches: 0, translated: 0, failed: 0 };
    let tried = [];

    while (!stopped) {
      const rows = store.translateQueue.claim({ limit: batchSize, maxAttempts, exclude: tried });
      if (rows.length === 0) break;

      const result = await runBatch(rows);

      totals.batches += 1;
      totals.translated += result.translated;
      totals.failed += result.failed;

      // ollama 整個連不上：這一輪收手。繼續跑只是對著同一個掛掉的服務重複等待，
      // 而下一次 kick（頁面載入、UI 的「現在就翻」）本來就會重試。
      if (result.fatal) {
        logger.warn('翻譯服務連不上，這一輪先收手');
        break;
      }

      if (result.failed > 0) tried = [...tried, ...rows.map((row) => row.hash)];
    }

    return totals;
  }

  /**
   * 把佇列跑到空（或跑到所有剩下的都沒有重試額度）。
   * 同時呼叫兩次只會有一條在跑 —— 第二個拿到同一個 promise。
   */
  function drain() {
    if (running) return running;

    running = loop()
      .catch((error) => {
        // loop 自己已經把每一批的錯誤接掉了，走到這裡是程式有 bug
        logger.error('翻譯佇列掛了', error);
        return { batches: 0, translated: 0, failed: 0 };
      })
      .finally(() => {
        running = null;
      });

    return running;
  }

  /** 射後不理。代理的請求路徑在呼叫這支，**絕對不能丟錯、不能慢**。 */
  function kick() {
    drain().catch(() => {});
  }

  /** 等目前這一輪跑完（測試與關機用）。沒在跑就立刻 resolve。 */
  function idle() {
    return running ?? Promise.resolve({ batches: 0, translated: 0, failed: 0 });
  }

  function stop() {
    stopped = true;
  }

  return { drain, kick, idle, stop, isRunning: () => running !== null, maxAttempts };
}

module.exports = { createTranslationQueue, MAX_ATTEMPTS };
