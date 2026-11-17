/* 儀表板的腳本表格：畫一列一支腳本、表頭排序、整列開關。 */
'use strict';

window.LocalMonkeyScriptsTable = (function createScriptsTable() {
  const { escapeHtml, byId, delegate } = window.LocalMonkeyUi;
  const { formatBytes, relativeTime, absoluteTime, sortRows } = window.LocalMonkeyFormat;

  /** 站點圖示最多畫幾個，剩下的收成 `+N` */
  const MAX_FAVICONS = 5;

  const state = {
    scripts: [],
    sort: { key: 'name', direction: 'asc' },
    handlers: {},
  };

  /* ------------------------------ 單格 ------------------------------ */

  function faviconsCell(siteIds) {
    if (siteIds.length === 0) return '<span class="warn-text" title="沒有任何網站">—</span>';

    const shown = siteIds.slice(0, MAX_FAVICONS).map((siteId) => {
      const id = escapeHtml(siteId);
      // /__lm/favicon/<siteId> 永遠回得出一張圖（抓不到就是佔位 SVG），所以不會破圖
      return `<img class="favicon" src="/__lm/favicon/${encodeURIComponent(siteId)}" alt="" title="${id}" width="16" height="16" loading="lazy">`;
    });

    const rest = siteIds.length - shown.length;
    const more = rest > 0 ? `<span class="favicon-more" title="還有 ${rest} 個">+${rest}</span>` : '';

    return `<span class="favicons">${shown.join('')}${more}</span>`;
  }

  /**
   * 功能欄的小圖示。hover 要看得到文字說明 —— 一排符號沒有說明等於沒有資訊。
   * 未支援的 @grant 標紅並講出是哪一個（那支腳本在代理模式下會少功能）。
   */
  function featuresCell(features) {
    const icons = [];

    if (features.requires > 0) {
      icons.push(`<span class="feature" title="${features.requires} 個 @require（已抓回本機）">🔗</span>`);
    }
    if (features.resources > 0) {
      icons.push(`<span class="feature" title="${features.resources} 個 @resource">📦</span>`);
    }
    if (features.grants > 0) {
      icons.push(`<span class="feature" title="${features.grants} 個 @grant（會載入 GM shim）">🔑</span>`);
    }
    if (features.unsupportedGrants.length > 0) {
      const names = escapeHtml(features.unsupportedGrants.join('、'));
      icons.push(
        `<span class="feature is-bad" title="代理模式不支援：${names}（投遞到 Tampermonkey 則完全正常）">⚠</span>`,
      );
    }
    if (features.delivery) {
      icons.push('<span class="feature" title="有投遞網址，可以直接裝進 Tampermonkey">📥</span>');
    }

    return icons.length > 0 ? icons.join('') : '<span class="muted">—</span>';
  }

  /** `#` 欄顯示的是 order_index 本身（可以直接改數字），不是畫面上的第幾列 */
  function row(script) {
    const id = escapeHtml(script.id);
    const features = script.featureFlags ?? {
      requires: 0,
      resources: 0,
      grants: 0,
      unsupportedGrants: [],
      delivery: false,
    };

    return `
      <tr class="script-row ${script.enabled ? '' : 'is-disabled'}" data-script-id="${id}">
        <td class="col-order">
          <input class="order-input" type="number" value="${Number(script.order_index) || 0}"
                 data-script-id="${id}" aria-label="執行順序" />
        </td>
        <td class="col-enabled">
          <label class="toggle" title="${script.enabled ? '已啟用' : '已停用'}">
            <input type="checkbox" class="enable-toggle" data-script-id="${id}" ${script.enabled ? 'checked' : ''} />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </td>
        <td class="col-name">
          <button type="button" class="link-name" data-script-id="${id}">${escapeHtml(script.name)}</button>
          ${script.description ? `<span class="row-sub">${escapeHtml(script.description)}</span>` : ''}
        </td>
        <td class="col-version mono">${script.version ? escapeHtml(script.version) : '<span class="muted">—</span>'}</td>
        <td class="col-size mono">${escapeHtml(formatBytes(script.size))}</td>
        <td class="col-sites">${faviconsCell(script.siteIds ?? script.site_ids ?? [])}</td>
        <td class="col-features">${featuresCell(features)}</td>
        <td class="col-updated" title="${escapeHtml(absoluteTime(script.updatedAt))}">${escapeHtml(relativeTime(script.updatedAt))}</td>
        <td class="col-actions">
          <button type="button" class="ghost" data-action="edit" data-script-id="${id}" title="編輯">✏️</button>
          <button type="button" class="ghost" data-action="delete" data-script-id="${id}" title="刪除">🗑</button>
        </td>
      </tr>`;
  }

  /* ------------------------------ 整張表 ------------------------------ */

  function renderSortIndicators() {
    for (const header of document.querySelectorAll('.scripts-table th.is-sortable')) {
      const active = header.dataset.sort === state.sort.key;
      header.classList.toggle('is-sorted', active);
      header.dataset.direction = active ? state.sort.direction : '';
    }
  }

  function render() {
    const sorted = sortRows(state.scripts, state.sort.key, state.sort.direction);

    byId('script-rows').innerHTML = sorted.map((script) => row(script)).join('');
    byId('script-list-empty').hidden = sorted.length > 0;
    renderSortIndicators();
  }

  function setScripts(scripts) {
    state.scripts = Array.isArray(scripts) ? scripts : [];
    render();
  }

  /** 點同一欄＝反向，點別欄＝換欄並回到升冪 */
  function toggleSort(key) {
    state.sort =
      state.sort.key === key
        ? { key, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' };

    render();
  }

  function init(handlers) {
    state.handlers = handlers ?? {};

    const table = byId('script-rows').closest('table');

    delegate(table, 'th.is-sortable', 'click', (event, header) => {
      toggleSort(header.dataset.sort);
    });

    // 名稱與 ✏️ 都是「進編輯器」
    delegate(table, '.link-name, [data-action="edit"]', 'click', (event, element) => {
      state.handlers.onEdit?.(element.dataset.scriptId);
    });

    delegate(table, '[data-action="delete"]', 'click', (event, element) => {
      state.handlers.onDelete?.(element.dataset.scriptId);
    });

    delegate(table, '.enable-toggle', 'change', (event, input) => {
      state.handlers.onToggle?.(input.dataset.scriptId, input.checked);
    });

    delegate(table, '.order-input', 'change', (event, input) => {
      state.handlers.onReorder?.(input.dataset.scriptId, Number(input.value));
    });
  }

  return { init, setScripts, toggleSort, getSort: () => ({ ...state.sort }) };
})();
