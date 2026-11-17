/*
 * 「已安裝的腳本」分頁。
 *
 * 兩層：第一層是表格（scripts-table.js 畫），點名稱或 ✏️ 才進第二層的編輯器。
 * 編輯器本身還是 v2 那一個（唯讀資訊列 + CodeMirror + 安裝網址列 + 版本提示），
 * 只是從「常駐並排」改成「從列表進入」。
 */
'use strict';

window.LocalMonkeyScriptsTab = (function createScriptsTab() {
  const { byId, debounce, banner, copyText } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;
  const infoBar = window.LocalMonkeyInfoBar;
  const table = window.LocalMonkeyScriptsTable;

  const PARSE_DELAY_MS = 300;

  const state = {
    scripts: [],
    selectedId: null,
    loaded: null, // 目前載進編輯器的那支（含 source 與 metadata）
    editor: null,
    onSitesChanged: () => {},
  };

  /** 一次只顯示一層 */
  function showEditor(open) {
    byId('editor-pane').hidden = !open;
    byId('list-view').hidden = open;
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

  /** 投遞模式的安裝網址（SPEC-console §8） */
  function renderDelivery(script) {
    const row = byId('delivery-row');
    if (!script.deliveryUrl) {
      row.hidden = true;
      return;
    }

    row.hidden = false;
    byId('delivery-url').textContent = script.deliveryUrl;
    byId('version-hint').hidden = true;
  }

  /**
   * ⛔ Tampermonkey 只有在遠端 @version 比本地高時才更新。版本沒往上走的話，
   *    使用者改完存檔會以為好了，但所有裝置原地不動 —— 一定要講出來。
   */
  function showVersionHint(result) {
    const hint = byId('version-hint');
    if (result.versionBumped !== false) {
      hint.hidden = true;
      return;
    }

    byId('version-hint-text').textContent =
      result.version === null || result.version === undefined
        ? '這支腳本沒有 @version —— Tampermonkey 永遠不會自動更新它。'
        : `版本號還是 ${result.version}，Tampermonkey 不會更新到這一版。`;

    hint.hidden = false;
  }

  async function select(scriptId) {
    try {
      const script = await api.getScript(scriptId);

      state.selectedId = scriptId;
      state.loaded = script;

      byId('editor-title').textContent = script.name;
      byId('editor-enabled').checked = script.enabled;
      byId('editor-enabled-label').textContent = script.enabled ? '啟用' : '停用';

      renderDelivery(script);
      showEditor(true);

      state.editor.setValue(script.source);
      state.editor.refresh();

      reparse(script.source);
    } catch (error) {
      banner.error(error);
    }
  }

  function backToList() {
    state.selectedId = null;
    state.loaded = null;
    showEditor(false);
    banner.hide();
  }

  async function save({ bumpVersion = false } = {}) {
    if (!state.selectedId) return;

    try {
      const result = await api.saveScript(state.selectedId, {
        source: state.editor.getValue(),
        enabled: byId('editor-enabled').checked,
        ...(bumpVersion ? { bumpVersion: true } : {}),
      });

      state.loaded = result.script;
      byId('editor-title').textContent = result.script.name;

      // 伺服器可能改過 source（版本 +1），讓編輯器跟著同步，不要兩份不一樣
      if (result.script.source !== state.editor.getValue()) {
        state.editor.setValue(result.script.source);
      }

      renderDelivery(result.script);
      showVersionHint(result);

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

  /** 從列表或編輯器都會呼叫；刪完一定回到列表 */
  async function remove(scriptId, name) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`確定要刪掉「${name}」？這個動作不能復原。`)) return;

    try {
      await api.deleteScript(scriptId);
      if (state.selectedId === scriptId) backToList();

      banner.show('已刪除。', 'ok');
      await refresh();
      state.onSitesChanged();
    } catch (error) {
      banner.error(error);
    }
  }

  function nameOf(scriptId) {
    return state.scripts.find((script) => script.id === scriptId)?.name ?? scriptId;
  }

  /** 列表上的開關：切換即時存檔 */
  async function setEnabled(scriptId, enabled) {
    try {
      await api.saveScript(scriptId, { enabled });
      await refresh();

      if (state.selectedId === scriptId) {
        byId('editor-enabled').checked = enabled;
        byId('editor-enabled-label').textContent = enabled ? '啟用' : '停用';
      }
    } catch (error) {
      banner.error(error);
      await refresh(); // 存檔失敗就把畫面轉回伺服器的真相
    }
  }

  async function setOrder(scriptId, orderIndex) {
    if (!Number.isInteger(orderIndex)) {
      await refresh();
      return;
    }

    try {
      await api.saveScript(scriptId, { order_index: orderIndex });
      await refresh();
    } catch (error) {
      banner.error(error);
      await refresh();
    }
  }

  async function refresh() {
    state.scripts = await api.listScripts();

    // 選中的那支被刪掉了（可能是在別的分頁刪的）→ 退回列表
    if (state.selectedId && !state.scripts.some((script) => script.id === state.selectedId)) {
      backToList();
    }

    table.setScripts(state.scripts);
  }

  function init({ onSitesChanged }) {
    state.onSitesChanged = onSitesChanged ?? (() => {});

    state.editor = window.LocalMonkeyEditor.createEditor(byId('editor'), {
      onChange: (value) => reparse(value),
      onSave: () => save(),
    });

    table.init({
      onEdit: (scriptId) => select(scriptId),
      onDelete: (scriptId) => remove(scriptId, nameOf(scriptId)),
      onToggle: (scriptId, enabled) => setEnabled(scriptId, enabled),
      onReorder: (scriptId, orderIndex) => setOrder(scriptId, orderIndex),
    });

    byId('editor-back').addEventListener('click', backToList);
    byId('editor-save').addEventListener('click', () => save());
    byId('version-bump').addEventListener('click', () => save({ bumpVersion: true }));

    byId('delivery-copy').addEventListener('click', () => {
      if (state.loaded?.deliveryUrl) copyText(state.loaded.deliveryUrl);
    });

    byId('delivery-open').addEventListener('click', () => {
      if (state.loaded?.deliveryUrl) window.open(state.loaded.deliveryUrl, '_blank', 'noopener');
    });

    byId('delivery-rotate').addEventListener('click', async () => {
      // eslint-disable-next-line no-alert
      if (!window.confirm('重新產生網址會讓舊網址失效。已經裝好的裝置之後會更新失敗，要重新安裝。要繼續嗎？')) {
        return;
      }

      try {
        const script = await api.rotateDeliveryToken(state.selectedId);
        state.loaded = script;
        renderDelivery(script);
        banner.show('已換成新的安裝網址。舊網址已失效，請在各裝置重新安裝。', 'warn');
      } catch (error) {
        banner.error(error);
      }
    });

    byId('editor-delete').addEventListener('click', () => {
      if (state.selectedId) remove(state.selectedId, state.loaded?.name ?? '');
    });

    byId('editor-enabled').addEventListener('change', (event) => {
      byId('editor-enabled-label').textContent = event.target.checked ? '啟用' : '停用';
    });

    return refresh();
  }

  return { init, refresh, select, backToList };
})();
