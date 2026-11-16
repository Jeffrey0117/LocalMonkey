/*
 * 「+ 丟腳本」：貼上（或拖放）一份 .user.js → 解析 → 顯示偵測到的網域 → 按部署才寫入。
 *
 * 這就是使用者描述的流程：「讓我丟油猴腳本，絕對能判斷啊」。
 */
'use strict';

window.LocalMonkeyDropScript = (function createDropScript() {
  const { escapeHtml, byId, debounce, banner } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;
  const infoBar = window.LocalMonkeyInfoBar;

  const PARSE_DELAY_MS = 300;

  const state = { parsed: null, fallbackName: null, onDeployed: () => {} };

  function targetRow(target) {
    return `
      <tr class="is-${target.proxyable}">
        <td>${infoBar.badge(target.proxyable)}</td>
        <td><code>${escapeHtml(target.pattern)}</code></td>
        <td>${target.host ? `<code>${escapeHtml(target.targetOrigin)}</code>` : '<span class="muted">—</span>'}</td>
        <td>${target.pathGlob ? `<code>${escapeHtml(target.pathGlob)}</code>` : '<span class="muted">—</span>'}</td>
        <td>${escapeHtml(target.reason ?? target.warning ?? '')}</td>
      </tr>`;
  }

  function renderPreview(parsed) {
    state.parsed = parsed;

    byId('drop-preview').hidden = false;
    infoBar.render(byId('drop-info'), parsed);
    byId('drop-targets').innerHTML = parsed.targets.map((target) => targetRow(target)).join('');

    const usable = parsed.targets.filter((target) => target.proxyable !== 'rejected').length;
    byId('drop-deploy').disabled = false;

    byId('drop-status').textContent =
      usable > 0
        ? `偵測到 ${usable} 個可以代理的網域（${parsed.name}）`
        : '沒有可以代理的網域。部署後腳本會存起來，用「安裝網址」讓 Tampermonkey 裝起來就能用（投遞模式）。';
  }

  const reparse = debounce(async (source) => {
    if (source.trim().length === 0) {
      byId('drop-preview').hidden = true;
      byId('drop-deploy').disabled = true;
      byId('drop-status').textContent = '';
      state.parsed = null;
      return;
    }

    try {
      renderPreview(await api.parse(source, state.fallbackName));
    } catch (error) {
      banner.error(error);
    }
  }, PARSE_DELAY_MS);

  async function deploy() {
    const source = byId('drop-source').value;
    if (source.trim().length === 0) return;

    byId('drop-deploy').disabled = true;

    try {
      const result = await api.deployScript(source, state.fallbackName);
      const created = result.targets.filter((target) => target.siteId !== null).length;

      banner.show(
        result.warnings.length > 0
          ? `已部署「${result.script.name}」（${created} 個網站）。注意：${result.warnings.join('；')}`
          : `已部署「${result.script.name}」，建好 ${created} 個網站。`,
        result.warnings.length > 0 ? 'warn' : 'ok',
      );

      close();
      await state.onDeployed(result.script.id);
    } catch (error) {
      banner.error(error);
      byId('drop-deploy').disabled = false;
    }
  }

  function open() {
    byId('drop-source').value = '';
    byId('drop-preview').hidden = true;
    byId('drop-deploy').disabled = true;
    byId('drop-status').textContent = '';
    state.parsed = null;
    state.fallbackName = null;

    const dialog = byId('drop-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    byId('drop-source').focus();
  }

  function close() {
    const dialog = byId('drop-dialog');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  async function readDroppedFile(file) {
    state.fallbackName = file.name;
    const text = await file.text();
    byId('drop-source').value = text;
    reparse(text);
  }

  function init({ onDeployed }) {
    state.onDeployed = onDeployed ?? (() => {});

    byId('drop-open').addEventListener('click', open);
    byId('drop-close').addEventListener('click', close);
    byId('drop-deploy').addEventListener('click', deploy);
    byId('drop-source').addEventListener('input', (event) => reparse(event.target.value));

    const zone = byId('drop-zone');

    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragging');

      const file = event.dataTransfer?.files?.[0];
      if (file) readDroppedFile(file).catch((error) => banner.error(error));
    });
  }

  return { init, open, close };
})();
