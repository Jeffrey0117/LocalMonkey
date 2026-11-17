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
  };
})();
