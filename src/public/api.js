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

    /* ---------------- 網站（唯讀清單 + 啟用開關 / 指定主機） ---------------- */

    getSettings: () => request('GET', '/settings').then((data) => data.settings),

    listSites: () => request('GET', '/sites').then((data) => data.sites),
    updateSite: (siteId, patch) => request('PATCH', `/sites/${id(siteId)}`, patch).then((data) => data.site),
    deleteSite: (siteId) => request('DELETE', `/sites/${id(siteId)}`),
  };
})();
