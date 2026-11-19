/* LocalMonkey 後台：API 呼叫層。原生 JS，沒有 build step。 */
'use strict';

window.LocalMonkeyApi = (function createApi() {
  const BASE = '/admin/api';

  /** 把後端的錯誤格式攤平成一句人看得懂的話 */
  function describeError(status, payload) {
    if (!payload) return `請求失敗（HTTP ${status}）`;
    if (Array.isArray(payload.details)) {
      return payload.details.map((detail) => `${detail.field}：${detail.message}`).join('\n');
    }
    if (payload.message) return payload.message;
    return `${payload.error ?? '未知錯誤'}（HTTP ${status}）`;
  }

  async function request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 204) return null;

    const text = await response.text();
    const payload = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = new Error(describeError(response.status, payload));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  const id = (value) => encodeURIComponent(value);

  return {
    /* ---------------- v2：腳本優先 ---------------- */

    /** 只解析不寫入（資訊列與「丟腳本」預覽都用這支，前後端共用同一個解析器） */
    parse: (source, fallbackName) =>
      request('POST', '/userscript/parse', fallbackName ? { source, fallbackName } : { source })
        .then((data) => data.parsed),

    listScripts: () => request('GET', '/scripts').then((data) => data.scripts),
    getScript: (scriptId) => request('GET', `/scripts/${id(scriptId)}`).then((data) => data.script),

    /** @returns {Promise<{script: object, targets: object[], warnings: string[]}>} */
    deployScript: (source, fallbackName) =>
      request('POST', '/scripts', fallbackName ? { source, fallbackName } : { source }),

    saveScript: (scriptId, patch) => request('PUT', `/scripts/${id(scriptId)}`, patch),
    deleteScript: (scriptId) => request('DELETE', `/scripts/${id(scriptId)}`),

    /** 重新產生投遞 token＝撤銷舊的安裝網址（已安裝的裝置要重裝） */
    rotateDeliveryToken: (scriptId) =>
      request('POST', `/scripts/${id(scriptId)}/delivery-token/rotate`, {}).then((data) => data.script),

    /* ---------------- 網站（唯讀清單 + 啟用開關 / 指定主機） ---------------- */

    getSettings: () => request('GET', '/settings').then((data) => data.settings),

    listSites: () => request('GET', '/sites').then((data) => data.sites),
    updateSite: (siteId, patch) => request('PATCH', `/sites/${id(siteId)}`, patch).then((data) => data.site),
    deleteSite: (siteId) => request('DELETE', `/sites/${id(siteId)}`),

    /* ---------------- v4：伺服器端翻譯層 ---------------- */

    /** 佇列狀態 + ollama 活著沒 */
    translateStatus: () => request('GET', '/translate/status'),

    /** 模型下拉選單。ollama 掛了不丟錯，回 `{ models: [], ok: false, error }` */
    translateModels: () => request('GET', '/translate/models'),

    listTranslations: ({ query, origin, limit, offset } = {}) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (origin) params.set('origin', origin);
      if (limit) params.set('limit', String(limit));
      if (offset) params.set('offset', String(offset));

      const suffix = params.toString();
      return request('GET', `/translate/entries${suffix ? `?${suffix}` : ''}`);
    },

    listFailedTranslations: () => request('GET', '/translate/failed').then((data) => data.failed),

    /** 人工覆寫：存檔後 origin = 'manual'，背景翻譯之後不會覆蓋它 */
    saveTranslation: (hash, translated) =>
      request('PUT', `/translate/entries/${id(hash)}`, { translated }).then((data) => data.entry),

    retranslate: (hash) => request('POST', `/translate/entries/${id(hash)}/retranslate`, {}),

    /** 翻不動的段：放棄它（原文照舊顯示） */
    dropFromQueue: (hash) => request('DELETE', `/translate/queue/${id(hash)}`),

    runQueue: () => request('POST', '/translate/run', {}),

    /* ---------------- 預先翻譯整站 ---------------- */

    startCrawl: (siteId, options) =>
      request('POST', `/sites/${id(siteId)}/crawl`, options ?? {}).then((data) => data.job),

    listCrawlJobs: (siteId) => request('GET', `/sites/${id(siteId)}/crawl`).then((data) => data.jobs),

    cancelCrawl: (siteId, jobId) =>
      request('POST', `/sites/${id(siteId)}/crawl/${id(jobId)}/cancel`, {}).then((data) => data.job),

    /* ---------------- 快取裡的簡體（SPEC-rules §5.1） ---------------- */

    listSimplified: () => request('GET', '/translate/simplified'),

    /** 預設跳過人工覆寫 —— 那是使用者自己打的字，砍掉不可逆 */
    retranslateSimplified: (includeManual = false) =>
      request('POST', '/translate/simplified/retranslate', { includeManual }),

    /* ---------------- v5：站台改造規則（SPEC-rules） ---------------- */

    listSiteRules: (siteId) => request('GET', `/sites/${id(siteId)}/rules`).then((data) => data.rules),

    createSiteRule: (siteId, rule) =>
      request('POST', `/sites/${id(siteId)}/rules`, rule).then((data) => data.rule),

    updateSiteRule: (siteId, ruleId, patch) =>
      request('PATCH', `/sites/${id(siteId)}/rules/${id(ruleId)}`, patch).then((data) => data.rule),

    deleteSiteRule: (siteId, ruleId) => request('DELETE', `/sites/${id(siteId)}/rules/${id(ruleId)}`),

    reorderSiteRules: (siteId, ids) =>
      request('POST', `/sites/${id(siteId)}/rules/reorder`, { ids }).then((data) => data.rules),

    /** 「試一下」：回每條文字規則命中幾段（hide 的由瀏覽器自己數） */
    dryRunRules: (siteId, path) => request('POST', `/sites/${id(siteId)}/rules/dry-run`, { path }),

    /* ---------------- v5：資源覆寫 ---------------- */

    listResources: (siteId) =>
      request('GET', `/sites/${id(siteId)}/resources`).then((data) => data.resources),

    /**
     * 上傳一張圖。
     *
     * ⛔ 不走 `request()`：body 是 `File` 本身（raw bytes），不是 JSON。
     * 這樣前端不用組 FormData、不用 base64 膨脹 33%，後端也不需要
     * multipart parser（零依賴）。
     */
    uploadResource: async (siteId, path, file) => {
      const response = await fetch(
        `${BASE}/sites/${id(siteId)}/resources?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        },
      );

      const text = await response.text();
      const payload = text.length > 0 ? JSON.parse(text) : null;

      if (!response.ok) throw new Error(describeError(response.status, payload));
      return payload.resource;
    },

    updateResource: (siteId, resourceId, enabled) =>
      request('PATCH', `/sites/${id(siteId)}/resources/${id(resourceId)}`, { enabled }).then(
        (data) => data.resource,
      ),

    deleteResource: (siteId, resourceId) =>
      request('DELETE', `/sites/${id(siteId)}/resources/${id(resourceId)}`),

    listResourceCandidates: (siteId, path) =>
      request(
        'GET',
        `/sites/${id(siteId)}/resource-candidates?path=${encodeURIComponent(path)}`,
      ).then((data) => data.candidates),

    /* ---------------- v8：重繪模式（SPEC-reskin） ---------------- */

    getReskin: (siteId) => request('GET', `/sites/${id(siteId)}/reskin`),

    /** 訂單清單（SPEC-checkout §3）。唯讀 —— 沒有對應的寫入端點。 */
    getReskinOrders: (siteId) => request('GET', `/sites/${id(siteId)}/reskin/orders`),

    /**
     * 存抽取設定。
     *
     * ⛔ **編不過也會存起來**（同壞規則的紀律）：回應帶 `config_error`，
     * UI 要標紅而不是把使用者手上那份半成品丟掉。所以這支不會因為設定壞掉
     * 而 throw —— 呼叫端要自己看 `config_error`。
     */
    saveReskinConfig: (siteId, config) =>
      request('PUT', `/sites/${id(siteId)}/reskin/config`, { config }),

    /** 價格方案相反：它是表單填出來的結構化資料，壞掉就擋在門口（會 throw） */
    saveReskinPricing: (siteId, pricing) =>
      request('PUT', `/sites/${id(siteId)}/reskin/pricing`, { pricing }),

    applyReskinPreset: (siteId) => request('POST', `/sites/${id(siteId)}/reskin/preset`),

    clearReskinCache: (siteId) => request('POST', `/sites/${id(siteId)}/reskin/cache/clear`),

    /** 「試一下」：回抽到幾項、每個欄位抽到什麼、沒抽到的話是哪一種原因 */
    dryRunReskin: (siteId, { path, config }) =>
      request('POST', `/sites/${id(siteId)}/reskin/dry-run`, { path, config }),
  };
})();
