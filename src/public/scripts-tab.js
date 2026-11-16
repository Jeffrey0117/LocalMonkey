/* 「腳本」分頁：左邊清單、右邊編輯器 + 唯讀資訊列。 */
'use strict';

window.LocalMonkeyScriptsTab = (function createScriptsTab() {
  const { escapeHtml, byId, debounce, banner, delegate } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;
  const infoBar = window.LocalMonkeyInfoBar;

  const PARSE_DELAY_MS = 300;

  const state = {
    scripts: [],
    selectedId: null,
    loaded: null, // 目前載進編輯器的那支（含 source 與 metadata）
    editor: null,
    onSitesChanged: () => {},
  };

  function listItem(script) {
    const dot = script.enabled ? 'is-on' : 'is-off';
    const version = script.version ? `<span class="muted">${escapeHtml(script.version)}</span>` : '';
    const sites = script.site_ids.length > 0
      ? `${script.site_ids.length} 個網站`
      : '<span class="warn-text">沒有網站</span>';

    return `
      <li class="script-item ${script.id === state.selectedId ? 'is-selected' : ''}" data-script-id="${escapeHtml(script.id)}">
        <span class="dot ${dot}"></span>
        <span class="script-name">${escapeHtml(script.name)}</span>
        ${version}
        <span class="script-sub">${sites}</span>
      </li>`;
  }

  function renderList() {
    byId('script-list').innerHTML = state.scripts.map((script) => listItem(script)).join('');
    byId('script-list-empty').hidden = state.scripts.length > 0;
  }

  function showPane(hasSelection) {
    byId('editor-pane').hidden = !hasSelection;
    byId('editor-empty').hidden = hasSelection;
  }

  /** 打字時重新解析：資訊列跟著 header 走 */
  const reparse = debounce(async (source) => {
    try {
      const parsed = await api.parse(source, state.loaded?.name);
      infoBar.render(byId('info-row'), parsed, state.loaded?.metadata);
    } catch (error) {
      banner.error(error);
    }
  }, PARSE_DELAY_MS);

  async function select(scriptId) {
    try {
      const script = await api.getScript(scriptId);

      state.selectedId = scriptId;
      state.loaded = script;

      byId('editor-title').textContent = script.name;
      byId('editor-enabled').checked = script.enabled;
      byId('editor-enabled-label').textContent = script.enabled ? '啟用' : '停用';

      showPane(true);
      state.editor.setValue(script.source);
      state.editor.refresh();

      renderList();
      reparse(script.source);
    } catch (error) {
      banner.error(error);
    }
  }

  async function save() {
    if (!state.selectedId) return;

    try {
      const result = await api.saveScript(state.selectedId, {
        source: state.editor.getValue(),
        enabled: byId('editor-enabled').checked,
      });

      state.loaded = result.script;
      byId('editor-title').textContent = result.script.name;

      const created = (result.targets ?? []).filter((target) => target.siteId !== null).length;
      const warnings = result.warnings ?? [];

      banner.show(
        warnings.length > 0
          ? `已儲存（掛在 ${created} 個網站）。注意：${warnings.join('；')}`
          : `已儲存，掛在 ${created} 個網站。重新載入代理頁面就生效。`,
        warnings.length > 0 ? 'warn' : 'ok',
      );

      await refresh();
      state.onSitesChanged();
      reparse(state.editor.getValue());
    } catch (error) {
      banner.error(error);
    }
  }

  async function remove() {
    if (!state.selectedId || !state.loaded) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`確定要刪掉「${state.loaded.name}」？這個動作不能復原。`)) return;

    try {
      await api.deleteScript(state.selectedId);
      state.selectedId = null;
      state.loaded = null;
      showPane(false);
      banner.show('已刪除。', 'ok');

      await refresh();
      state.onSitesChanged();
    } catch (error) {
      banner.error(error);
    }
  }

  async function refresh() {
    state.scripts = await api.listScripts();

    if (state.selectedId && !state.scripts.some((script) => script.id === state.selectedId)) {
      state.selectedId = null;
      state.loaded = null;
      showPane(false);
    }

    renderList();
  }

  function init({ onSitesChanged }) {
    state.onSitesChanged = onSitesChanged ?? (() => {});

    state.editor = window.LocalMonkeyEditor.createEditor(byId('editor'), {
      onChange: (value) => reparse(value),
      onSave: () => save(),
    });

    delegate(byId('script-list'), '.script-item', 'click', (event, item) => {
      select(item.dataset.scriptId);
    });

    byId('editor-save').addEventListener('click', save);
    byId('editor-delete').addEventListener('click', remove);
    byId('editor-enabled').addEventListener('change', (event) => {
      byId('editor-enabled-label').textContent = event.target.checked ? '啟用' : '停用';
    });

    return refresh();
  }

  return { init, refresh, select };
})();
