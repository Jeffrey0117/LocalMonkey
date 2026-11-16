/*
 * 「網站」分頁：唯讀清單。
 *
 * 網站是腳本的 @match 自動建出來的，所以這裡不給新增、不給改配對。
 * 能動的只有兩件事：啟用開關，以及「萬用子網域要指向哪個具體主機」。
 */
'use strict';

window.LocalMonkeySitesTab = (function createSitesTab() {
  const { escapeHtml, byId, banner, copyText, delegate } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;

  const state = { sites: [] };

  function proxyPath(site) {
    return `/p/${site.id}/`;
  }

  function scriptsCell(site) {
    if (site.scripts.length === 0) return '<span class="muted">—</span>';

    return site.scripts
      .map(
        (script) =>
          `<span class="chip ${script.enabled ? '' : 'is-muted'}">${escapeHtml(script.name)}</span>`,
      )
      .join('');
  }

  function row(site) {
    const path = proxyPath(site);
    const origin = escapeHtml(site.target_origin);
    const wildcardHint = site.from_pattern
      ? `<span class="muted" title="來源 @match">${escapeHtml(site.from_pattern)}</span>`
      : '';

    return `
      <tr data-site-id="${escapeHtml(site.id)}">
        <td>
          <div class="site-name">${escapeHtml(site.name)}</div>
          <div class="site-sub">
            <code>${escapeHtml(site.id)}</code>
            ${site.auto_created ? '<span class="badge is-ok">自動建立</span>' : '<span class="badge">手動</span>'}
          </div>
          <div class="site-sub">${wildcardHint}</div>
        </td>
        <td>
          <code>${escapeHtml(path)}</code>
          <div class="site-actions">
            <button type="button" class="ghost" data-action="copy">複製</button>
            <button type="button" class="ghost" data-action="open">開啟</button>
          </div>
        </td>
        <td>
          <input class="origin-input" data-action="origin" value="${origin}" spellcheck="false" />
          <div class="site-actions">
            <button type="button" class="ghost" data-action="save-origin">改主機</button>
          </div>
        </td>
        <td>${scriptsCell(site)}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-action="toggle" ${site.enabled ? 'checked' : ''} />
            <span>${site.enabled ? '啟用' : '停用'}</span>
          </label>
        </td>
      </tr>`;
  }

  function render() {
    byId('site-rows').innerHTML = state.sites.map((site) => row(site)).join('');
    byId('site-list-empty').hidden = state.sites.length > 0;
  }

  async function refresh() {
    state.sites = await api.listSites();
    render();
  }

  function siteIdOf(element) {
    return element.closest('tr')?.dataset.siteId ?? null;
  }

  async function withErrorBanner(action) {
    try {
      await action();
    } catch (error) {
      banner.error(error);
      await refresh();
    }
  }

  function init() {
    const rows = byId('site-rows');

    delegate(rows, '[data-action="copy"]', 'click', (event, button) => {
      const site = state.sites.find((entry) => entry.id === siteIdOf(button));
      if (site) copyText(`${window.location.origin}${proxyPath(site)}`);
    });

    delegate(rows, '[data-action="open"]', 'click', (event, button) => {
      const site = state.sites.find((entry) => entry.id === siteIdOf(button));
      if (site) window.open(proxyPath(site), '_blank', 'noopener');
    });

    delegate(rows, '[data-action="toggle"]', 'change', (event, input) => {
      const siteId = siteIdOf(input);
      withErrorBanner(async () => {
        await api.updateSite(siteId, { enabled: input.checked });
        banner.show(`${siteId} 已${input.checked ? '啟用' : '停用'}。`, 'ok');
        await refresh();
      });
    });

    delegate(rows, '[data-action="save-origin"]', 'click', (event, button) => {
      const siteId = siteIdOf(button);
      const input = button.closest('tr')?.querySelector('[data-action="origin"]');
      if (!input) return;

      withErrorBanner(async () => {
        await api.updateSite(siteId, { target_origin: input.value.trim() });
        banner.show(`${siteId} 的目標主機已改成 ${input.value.trim()}。`, 'ok');
        await refresh();
      });
    });

    return refresh();
  }

  return { init, refresh };
})();
