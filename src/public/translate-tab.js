/*
 * 「翻譯」分頁（SPEC-translate §7）。
 *
 * 一張表：原文 / 譯文 / 來源（機器・人工）/ 語言與模型 / 更新時間。
 * 譯文可以直接點進去改（存檔後 origin = 'manual'，背景翻譯之後不會覆蓋它）。
 * 另外有「只看翻不動的」—— 那些是 attempts >= 3 的段，要人工處理。
 */
'use strict';

window.LocalMonkeyTranslateTab = (function createTranslateTab() {
  const { escapeHtml, byId, banner, debounce, delegate } = window.LocalMonkeyUi;
  const { relativeTime } = window.LocalMonkeyFormat;
  const api = window.LocalMonkeyApi;

  const PAGE_SIZE = 200;

  const state = {
    entries: [],
    failed: [],
    counts: { total: 0, manual: 0 },
    queue: { pending: 0, failed: 0, total: 0 },
    status: null,
    query: '',
    onlyManual: false,
    onlyFailed: false,
  };

  /* -------------------------------- 狀態列 -------------------------------- */

  function statusLine() {
    const ollama = state.status?.ollama;

    const health = ollama?.ok
      ? `<span class="badge is-ok">翻譯服務正常</span>
         <span class="muted">${escapeHtml(ollama.model ?? '')}</span>`
      : `<span class="badge is-bad">翻譯服務連不上</span>
         <span class="muted">${escapeHtml(ollama?.error ?? '')}</span>`;

    return `
      ${health}
      <span class="muted">${escapeHtml(ollama?.url ?? '')}</span>
      <span>快取 ${state.counts.total} 段（人工 ${state.counts.manual}）</span>
      <span>待翻 ${state.queue.pending} 段</span>
      ${
        state.queue.failed > 0
          ? `<span class="badge is-warn">翻不動 ${state.queue.failed} 段</span>`
          : ''
      }`;
  }

  /* --------------------------------- 表格 --------------------------------- */

  const ORIGIN_LABELS = { machine: '機器', manual: '人工' };

  function entryRow(entry) {
    return `
      <tr data-hash="${escapeHtml(entry.hash)}">
        <td class="col-source">${escapeHtml(entry.source_text)}</td>
        <td class="col-target">
          <textarea
            class="translation-input"
            data-action="translated"
            rows="1"
            spellcheck="false"
          >${escapeHtml(entry.translated)}</textarea>
        </td>
        <td class="col-origin">
          <span class="badge ${entry.origin === 'manual' ? 'is-ok' : ''}">
            ${ORIGIN_LABELS[entry.origin] ?? escapeHtml(entry.origin)}
          </span>
        </td>
        <td class="col-lang">
          <div>${escapeHtml(entry.target_lang)}</div>
          <div class="muted">${escapeHtml(entry.model)}</div>
        </td>
        <td class="col-updated muted">${escapeHtml(relativeTime(entry.updated_at))}</td>
        <td class="col-actions">
          <button type="button" class="ghost" data-action="save">儲存</button>
          <button type="button" class="ghost" data-action="retranslate">重翻</button>
        </td>
      </tr>`;
  }

  /** 翻不動的那些還沒有譯文，所以是另一種列（只能重翻或放棄） */
  function failedRow(row) {
    return `
      <tr data-hash="${escapeHtml(row.hash)}" class="is-failed">
        <td class="col-source">${escapeHtml(row.source_text)}</td>
        <td class="col-target muted">（翻不動，顯示原文）</td>
        <td class="col-origin"><span class="badge is-bad">失敗 ${row.attempts} 次</span></td>
        <td class="col-lang">
          <div>${escapeHtml(row.target_lang)}</div>
          <div class="muted">${escapeHtml(row.model)}</div>
        </td>
        <td class="col-updated muted">${escapeHtml(row.last_error ?? '')}</td>
        <td class="col-actions">
          <button type="button" class="ghost" data-action="requeue">再試一次</button>
          <button type="button" class="ghost" data-action="drop">放棄</button>
        </td>
      </tr>`;
  }

  function render() {
    byId('translate-status').innerHTML = statusLine();

    const rows = state.onlyFailed
      ? state.failed.map((row) => failedRow(row))
      : state.entries.map((entry) => entryRow(entry));

    byId('translate-rows').innerHTML = rows.join('');
    byId('translate-list-empty').hidden = rows.length > 0;
  }

  /* -------------------------------- 取資料 -------------------------------- */

  async function refresh() {
    const [listed, status, failed] = await Promise.all([
      api.listTranslations({
        query: state.query,
        origin: state.onlyManual ? 'manual' : undefined,
        limit: PAGE_SIZE,
      }),
      // ollama 掛掉不該讓整個分頁爆掉 —— 狀態列自己會顯示「連不上」
      api.translateStatus().catch(() => null),
      api.listFailedTranslations().catch(() => []),
    ]);

    state.entries = listed.entries;
    state.counts = listed.counts;
    state.queue = listed.queue;
    state.status = status;
    state.failed = failed;

    render();
  }

  function hashOf(element) {
    return element.closest('tr')?.dataset.hash ?? null;
  }

  function withErrorBanner(action) {
    return action().catch((error) => banner.error(error));
  }

  function init() {
    const rows = byId('translate-rows');

    delegate(rows, '[data-action="save"]', 'click', (event, button) => {
      const hash = hashOf(button);
      const input = button.closest('tr')?.querySelector('[data-action="translated"]');
      if (!hash || !input) return;

      withErrorBanner(async () => {
        await api.saveTranslation(hash, input.value);
        banner.show('已存成人工覆寫，背景翻譯不會再蓋掉它。', 'ok');
        await refresh();
      });
    });

    delegate(rows, '[data-action="retranslate"]', 'click', (event, button) => {
      const hash = hashOf(button);
      if (!hash) return;

      withErrorBanner(async () => {
        await api.retranslate(hash);
        banner.show('已排進佇列重翻（翻好之後重新整理就看得到）。', 'ok');
        await refresh();
      });
    });

    delegate(rows, '[data-action="requeue"]', 'click', (event, button) => {
      const hash = hashOf(button);
      if (!hash) return;

      withErrorBanner(async () => {
        // 翻不動的段：把失敗紀錄清掉再排一次（attempts 歸零）
        await api.dropFromQueue(hash);
        await api.runQueue();
        banner.show('已重排。如果還是翻不動，就改成人工覆寫吧。', 'warn');
        await refresh();
      });
    });

    delegate(rows, '[data-action="drop"]', 'click', (event, button) => {
      const hash = hashOf(button);
      if (!hash) return;

      withErrorBanner(async () => {
        await api.dropFromQueue(hash);
        banner.show('已從佇列移除，那一段會繼續顯示原文。', 'ok');
        await refresh();
      });
    });

    byId('translate-search').addEventListener(
      'input',
      debounce((event) => {
        state.query = event.target.value.trim();
        withErrorBanner(refresh);
      }, 250),
    );

    byId('translate-only-manual').addEventListener('change', (event) => {
      state.onlyManual = event.target.checked;
      withErrorBanner(refresh);
    });

    byId('translate-only-failed').addEventListener('change', (event) => {
      state.onlyFailed = event.target.checked;
      render();
    });

    byId('translate-run').addEventListener('click', () => {
      withErrorBanner(async () => {
        const result = await api.runQueue();
        banner.show(`已推一把，佇列裡還有 ${result.queue.pending} 段。`, 'ok');
      });
    });

    byId('translate-refresh').addEventListener('click', () => withErrorBanner(refresh));

    return refresh();
  }

  return { init, refresh };
})();
