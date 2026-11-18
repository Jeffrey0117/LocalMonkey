/*
 * 「網站」分頁裡每一站展開來的翻譯設定（SPEC-translate §7）。
 *
 * 開關、目標語言、模型（從 ollama 的 /api/tags 撈）、術語表，
 * 以及「預先翻譯整站」的按鈕 + 進度條 + 取消。
 *
 * 這一塊單獨一個檔案而不是塞進 sites-tab.js：那支已經在管清單、啟用開關與
 * 目標主機，再加一組表單就會變成一個什麼都做的大檔案。
 */
'use strict';

window.LocalMonkeySiteTranslate = (function createSiteTranslate() {
  const { escapeHtml, banner, delegate } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;

  const LANGUAGES = [
    ['zh-TW', '繁體中文'],
    ['zh-CN', '简体中文'],
    ['en', 'English'],
    ['ja', '日本語'],
    ['ko', '한국어'],
  ];

  /** 爬蟲在跑的時候輪詢進度。沒有 WebSocket，進度在 crawl_jobs 裡。 */
  const POLL_MS = 1500;

  const state = {
    /** siteId → 展開了沒 */
    open: new Set(),
    models: { models: [], ok: true, error: null },
    /** siteId → 最近一筆 job */
    jobs: new Map(),
    timer: null,
    onChanged: () => {},
  };

  function isRunning(job) {
    return job?.status === 'running';
  }

  /* -------------------------------- 畫面 -------------------------------- */

  function modelOptions(site) {
    const chosen = site.translate_model ?? '';
    const options = [
      `<option value=""${chosen === '' ? ' selected' : ''}>（用全域預設）</option>`,
      ...state.models.models.map(
        (name) =>
          `<option value="${escapeHtml(name)}"${name === chosen ? ' selected' : ''}>${escapeHtml(name)}</option>`,
      ),
    ];

    // 站台設定的模型已經不在 ollama 裡了（換過模型 / 刪掉了）→ 還是要顯示出來，
    // 不然使用者會以為自己選的是「用全域預設」
    if (chosen !== '' && !state.models.models.includes(chosen)) {
      options.push(`<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)}（不在 ollama 裡）</option>`);
    }

    return options.join('');
  }

  function languageOptions(site) {
    return LANGUAGES.map(
      ([code, label]) =>
        `<option value="${code}"${code === site.translate_lang ? ' selected' : ''}>${label}（${code}）</option>`,
    ).join('');
  }

  function progressRow(site) {
    const job = state.jobs.get(site.id);
    if (!job) return '';

    const done = job.pages_done ?? 0;
    const found = Math.max(job.pages_found ?? 0, done);
    const percent = found === 0 ? 0 : Math.round((done / found) * 100);
    const eta = job.eta_ms > 0 ? `，預估還要 ${Math.ceil(job.eta_ms / 1000)} 秒` : '';

    const STATUS_LABELS = {
      running: '進行中',
      done: '完成',
      cancelled: '已取消',
      failed: '失敗',
      paused: '暫停',
    };

    return `
      <div class="crawl-progress">
        <div class="crawl-bar"><span style="width: ${percent}%"></span></div>
        <div class="crawl-numbers">
          <span class="badge ${job.status === 'done' ? 'is-ok' : job.status === 'failed' ? 'is-bad' : ''}">
            ${STATUS_LABELS[job.status] ?? escapeHtml(job.status)}
          </span>
          <span>${done} / ${found} 頁</span>
          <span>新增 ${job.segments_new ?? 0} 段</span>
          <span>待翻 ${job.segments_pending ?? 0} 段${eta}</span>
          ${isRunning(job) ? '<button type="button" class="ghost" data-action="crawl-cancel">取消</button>' : ''}
        </div>
        ${job.last_error ? `<p class="notice is-bad">${escapeHtml(job.last_error)}</p>` : ''}
      </div>`;
  }

  /** 展開後的那一大塊。回字串，由 sites-tab 塞進它自己的 row。 */
  function panel(site) {
    if (!state.open.has(site.id)) return '';

    const job = state.jobs.get(site.id);

    return `
      <div class="translate-settings">
        <div class="field">
          <label class="field-label" for="tl-lang-${escapeHtml(site.id)}">目標語言</label>
          <select id="tl-lang-${escapeHtml(site.id)}" data-action="lang">${languageOptions(site)}</select>
        </div>

        <div class="field">
          <label class="field-label" for="tl-model-${escapeHtml(site.id)}">模型</label>
          <select id="tl-model-${escapeHtml(site.id)}" data-action="model">${modelOptions(site)}</select>
          ${state.models.ok ? '' : '<p class="notice is-bad">翻譯服務連不上，模型清單撈不到</p>'}
        </div>

        <div class="field field-wide">
          <label class="field-label" for="tl-glossary-${escapeHtml(site.id)}">
            術語表（一行一個，這些詞不翻）
          </label>
          <textarea
            id="tl-glossary-${escapeHtml(site.id)}"
            data-action="glossary"
            class="glossary-input"
            spellcheck="false"
            rows="4"
          >${escapeHtml(site.glossary.join('\n'))}</textarea>
        </div>

        <div class="field field-wide">
          <p class="notice">
            第一次造訪某一頁會先看到原文（背景正在翻，下次載入就是中文）——
            這是設計行為，不是壞掉。<strong>不想讓任何人看到英文</strong>的話，
            在這裡按「預先翻譯整站」先把整站翻好。
          </p>
        </div>

        <div class="field field-wide translate-settings-actions">
          <button type="button" class="ghost" data-action="save-translate">儲存翻譯設定</button>
          <button type="button" class="primary" data-action="crawl" ${isRunning(job) ? 'disabled' : ''}>
            預先翻譯整站
          </button>
          <label class="crawl-option">
            最多
            <input type="number" data-action="max-pages" value="50" min="1" max="500" class="small-number" />
            頁，深度
            <input type="number" data-action="max-depth" value="3" min="0" max="10" class="small-number" />
          </label>
        </div>

        ${progressRow(site)}
      </div>`;
  }

  /** 清單那一欄的摘要（翻譯開著沒、哪個語言） */
  function summary(site) {
    const expanded = state.open.has(site.id);

    return `
      <div class="site-sub">
        ${
          site.translate_enabled
            ? `<span class="badge is-ok">${escapeHtml(site.translate_lang)}</span>`
            : '<span class="badge">關閉</span>'
        }
        <button type="button" class="ghost" data-action="translate-toggle-panel">
          ${expanded ? '收起' : '設定'}
        </button>
      </div>
      <label class="switch">
        <input type="checkbox" data-action="translate-enabled" ${site.translate_enabled ? 'checked' : ''} />
        <span>翻譯</span>
      </label>`;
  }

  /* -------------------------------- 行為 -------------------------------- */

  function fieldValue(row, action) {
    return row.querySelector(`[data-action="${action}"]`)?.value ?? '';
  }

  async function refreshJobs(siteIds) {
    const results = await Promise.all(
      siteIds.map((siteId) =>
        api
          .listCrawlJobs(siteId)
          .then((jobs) => [siteId, jobs[0] ?? null])
          .catch(() => [siteId, null]),
      ),
    );

    for (const [siteId, job] of results) {
      if (job) state.jobs.set(siteId, job);
    }

    return results.some(([, job]) => isRunning(job));
  }

  /** 有工作在跑就持續輪詢；跑完自動停下來（不要留一個永遠在打 API 的計時器） */
  function schedulePoll() {
    if (state.timer !== null) return;

    state.timer = setInterval(async () => {
      const watching = [...state.jobs.entries()]
        .filter(([, job]) => isRunning(job))
        .map(([siteId]) => siteId);

      if (watching.length === 0) {
        clearInterval(state.timer);
        state.timer = null;
        return;
      }

      await refreshJobs(watching);
      state.onChanged();
    }, POLL_MS);
  }

  async function loadModels() {
    try {
      state.models = await api.translateModels();
    } catch {
      state.models = { models: [], ok: false, error: '撈不到模型清單' };
    }
  }

  /**
   * 掛事件。sites-tab 的清單是重畫的，所以 listener 掛在容器上（事件委派）。
   *
   * @param {HTMLElement} container
   * @param {{ siteOf: (element: Element) => object|null, onChanged: () => void }} hooks
   */
  function init(container, { siteOf, onChanged }) {
    state.onChanged = onChanged;

    const withBanner = async (action) => {
      try {
        await action();
      } catch (error) {
        banner.error(error);
      }
    };

    delegate(container, '[data-action="translate-toggle-panel"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      if (state.open.has(site.id)) state.open.delete(site.id);
      else state.open.add(site.id);

      withBanner(async () => {
        if (state.open.has(site.id)) {
          await loadModels();
          await refreshJobs([site.id]);
        }
        onChanged();
      });
    });

    delegate(container, '[data-action="translate-enabled"]', 'change', (event, input) => {
      const site = siteOf(input);
      if (!site) return;

      withBanner(async () => {
        await api.updateSite(site.id, { translate_enabled: input.checked });
        banner.show(
          `${site.id} 的翻譯已${input.checked ? '打開（開一次頁面就會開始翻）' : '關閉'}。`,
          'ok',
        );
        onChanged();
      });
    });

    delegate(container, '[data-action="save-translate"]', 'click', (event, button) => {
      const site = siteOf(button);
      const row = button.closest('tr');
      if (!site || !row) return;

      withBanner(async () => {
        await api.updateSite(site.id, {
          translate_lang: fieldValue(row, 'lang'),
          translate_model: fieldValue(row, 'model') || null,
          glossary: fieldValue(row, 'glossary'),
        });
        banner.show(`${site.id} 的翻譯設定已儲存。`, 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="crawl"]', 'click', (event, button) => {
      const site = siteOf(button);
      const row = button.closest('tr');
      if (!site || !row) return;

      withBanner(async () => {
        const job = await api.startCrawl(site.id, {
          maxPages: Number(fieldValue(row, 'max-pages')) || 50,
          maxDepth: Number(fieldValue(row, 'max-depth')) || 0,
        });

        state.jobs.set(site.id, job);
        banner.show(`開始預先翻譯 ${site.id}（最多 ${job.max_pages} 頁）。`, 'ok');
        onChanged();
        schedulePoll();
      });
    });

    delegate(container, '[data-action="crawl-cancel"]', 'click', (event, button) => {
      const site = siteOf(button);
      const job = site ? state.jobs.get(site.id) : null;
      if (!site || !job) return;

      withBanner(async () => {
        state.jobs.set(site.id, await api.cancelCrawl(site.id, job.id));
        banner.show(`已取消 ${site.id} 的爬取。`, 'warn');
        onChanged();
      });
    });
  }

  /** 進分頁時叫一次：把正在跑的工作接回來（重新載入後進度條不會消失） */
  async function hydrate(sites) {
    if (sites.length === 0) return;

    const running = await refreshJobs(sites.filter((site) => site.translate_enabled).map((site) => site.id));
    if (running) schedulePoll();
  }

  return { init, panel, summary, hydrate };
})();
