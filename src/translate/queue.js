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
 * 一輪跑完、但還有做得動的段時，隔多久自己再試一次。
 *
 * ⛔ 為什麼需要這個：二分讓失敗變少，但沒解決「**誰來開始下一輪**」。
 * 實測到的使用者症狀是「永遠差 20 段」—— 那些段的 attempts 還沒滿、下一輪
 * 會重新納入，但如果使用者不再載入任何頁面，就沒有下一輪。
 */
const RETRY_DELAY_MS = 30_000;

/**
 * @param {{
 *   store: object,
 *   client: { translateBatch: Function, model: string },
 *   logger: object,
 *   batchSize?: number,
 *   maxAttempts?: number,
 * }} context
 */
function createTranslationQueue({
  store,
  client,
  logger,
  batchSize = 20,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
}) {
  let running = null;
  let stopped = false;
  let retryTimer = null;

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
   * 這一輪結束了，但還有「做得動」的段 → 自己排下一輪。
   *
   * 「做得動」的定義是 `attempts < maxAttempts`：已經標成翻不動的段不算，
   * 不然佇列會對著永遠失敗的那幾段空轉。
   *
   * ⛔ 計時器要 `unref()`：伺服器本來就有 HTTP handle 撐著 event loop，
   * 但測試與一次性 CLI 不該被一個背景計時器吊住不結束。
   * （這跟 ollama 的逾時計時器**剛好相反** —— 那支不准 unref，因為那時候
   * 正好沒有別的東西撐著，unref 了就不會醒。）
   */
  function scheduleRetry() {
    if (stopped || retryTimer !== null) return;
    if (store.translateQueue.claim({ limit: 1, maxAttempts }).length === 0) return;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) kick();
    }, retryDelayMs);

    retryTimer.unref?.();
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
        scheduleRetry();
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

  /**
   * 啟動時把「上次沒翻完的段」接回去。
   *
   * ⛔ 佇列是存在 DB 裡的，所以它會活過重啟 —— 而 `scheduleRetry` 只在
   * 「跑完一輪之後」才會接下一輪。少了這支，重開 server 之後那些段
   * **永遠不會被碰**，直到有人剛好載入一次頁面（實測：四分鐘完全不動）。
   *
   * 佇列空的時候是 no-op，所以不會為了沒有的工作去打 ollama。
   */
  function resume() {
    if (stopped) return false;
    if (store.translateQueue.claim({ limit: 1, maxAttempts }).length === 0) return false;

    logger.info('佇列裡還有上次沒翻完的段，接回去繼續');
    kick();
    return true;
  }

  function stop() {
    stopped = true;

    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  return { drain, kick, idle, stop, resume, isRunning: () => running !== null, maxAttempts };
}

module.exports = { createTranslationQueue, MAX_ATTEMPTS, RETRY_DELAY_MS };
