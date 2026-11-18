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
  const siteTranslate = window.LocalMonkeySiteTranslate;
  const siteRules = window.LocalMonkeySiteRules;
  const siteReskin = window.LocalMonkeySiteReskin;

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
        <td>${siteTranslate.summary(site)}</td>
        <td>${siteRules.summary(site)}</td>
        <td>${siteReskin.summary(site)}</td>
        <td>
          <label class="switch">
            <input type="checkbox" data-action="toggle" ${site.enabled ? 'checked' : ''} />
            <span>${site.enabled ? '啟用' : '停用'}</span>
          </label>
        </td>
      </tr>
      ${translateRow(site)}
      ${rulesRow(site)}
      ${reskinRow(site)}`;
  }

  /**
   * 翻譯設定是「展開在下一列」而不是跳對話框：它有五個欄位 + 進度條，
   * 塞進那一格會把整張表撐歪，而對話框會讓使用者看不到自己在設哪一站。
   *
   * `colspan` 要跟表頭的欄數一致（現在是 **8 欄** —— 加「改造規則」那一欄的
   * 時候漏改過一次，展開的那一塊會縮成一格寬；加「重繪」那一欄時三個
   * `colspan` 都要一起改）。
   */
  function translateRow(site) {
    const panel = siteTranslate.panel(site);
    if (panel === '') return '';

    return `
      <tr class="translate-row" data-site-id="${escapeHtml(site.id)}">
        <td colspan="8">${panel}</td>
      </tr>`;
  }

  /** 改造規則（SPEC-rules §4）也是展開在下一列，同一個理由 */
  function rulesRow(site) {
    const panel = siteRules.panel(site);
    if (panel === '') return '';

    return `
      <tr class="translate-row" data-site-id="${escapeHtml(site.id)}">
        <td colspan="8">${panel}</td>
      </tr>`;
  }

  /** 重繪設定（SPEC-reskin §6）也是展開在下一列，同一個理由 */
  function reskinRow(site) {
    const panel = siteReskin.panel(site);
    if (panel === '') return '';

    return `
      <tr class="translate-row" data-site-id="${escapeHtml(site.id)}">
        <td colspan="8">${panel}</td>
      </tr>`;
  }

  function render() {
    byId('site-rows').innerHTML = state.sites.map((site) => row(site)).join('');
    byId('site-list-empty').hidden = state.sites.length > 0;
  }

  /** 進分頁時把正在跑的爬取工作接回來（重新載入後進度條不該消失） */
  function hydrate() {
    return siteTranslate.hydrate(state.sites).then(() => render());
  }

  async function refresh() {
    state.sites = await api.listSites();
    render();
  }

  function siteIdOf(element) {
    return element.closest('tr')?.dataset.siteId ?? null;
  }

  function siteOf(element) {
    return state.sites.find((entry) => entry.id === siteIdOf(element)) ?? null;
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

    // 翻譯設定（展開列）自己掛一組事件委派，同一個容器
    siteTranslate.init(rows, { siteOf: (element) => siteOf(element), onChanged: () => render() });
    siteRules.init(rows, {
      siteOf: (element) => siteOf(element),
      onChanged: () => render(),
      // 改了站本身的欄位（dev_mode）要重新抓清單，不然 render() 會拿舊的 site 物件
      onSiteChanged: () => refresh(),
    });
    siteReskin.init(rows, {
      siteOf: (element) => siteOf(element),
      onChanged: () => render(),
      // reskin_enabled / reskin_theme 存在 site 上 → 改完要重抓清單
      onSiteChanged: () => refresh(),
    });

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

  return { init, refresh, hydrate };
})();
