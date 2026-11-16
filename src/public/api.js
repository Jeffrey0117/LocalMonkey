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
      throw error;
    }

    return payload;
  }

  return {
    listSites: () => request('GET', '/sites').then((data) => data.sites),
    createSite: (input) => request('POST', '/sites', input).then((data) => data.site),
    updateSite: (id, patch) => request('PUT', `/sites/${encodeURIComponent(id)}`, patch),
    deleteSite: (id) => request('DELETE', `/sites/${encodeURIComponent(id)}`),

    listScripts: (siteId) =>
      request('GET', `/sites/${encodeURIComponent(siteId)}/scripts`).then((data) => data.scripts),
    createScript: (siteId, input) =>
      request('POST', `/sites/${encodeURIComponent(siteId)}/scripts`, input),
    updateScript: (scriptId, patch) =>
      request('PUT', `/scripts/${encodeURIComponent(scriptId)}`, patch),
    deleteScript: (scriptId) => request('DELETE', `/scripts/${encodeURIComponent(scriptId)}`),
  };
})();
