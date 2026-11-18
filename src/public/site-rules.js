/*
 * 「網站」分頁裡每一站展開來的**改造規則**與**資源覆寫**（SPEC-rules §4 / §3.6）。
 *
 * 一條一列：型別、pattern、replacement、scope、備註、啟用、上下移、刪除。
 *
 * ⛔ 寫規則最怕的是「寫了沒反應」，所以這一塊的重點是「試一下」：
 *   - 文字規則的命中數由伺服器算（它要切段 + 套規則，而且要先翻譯）
 *   - `hide` 的命中數**在瀏覽器裡算** —— 那需要真的 CSS 比對，所以這裡抓一份
 *     代理過的頁面，用 DOMParser + querySelectorAll 自己數。伺服器端沒有 DOM，
 *     硬要在那邊做只會做出一個「看起來像 CSS 但不是 CSS」的比對器。
 *
 * 單獨一個檔案的理由同 site-translate.js：sites-tab.js 不該變成什麼都做的大檔案。
 */
'use strict';

window.LocalMonkeySiteRules = (function createSiteRules() {
  const { escapeHtml, banner, delegate } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;

  const KINDS = [
    ['hide', '隱藏元素'],
    ['text-replace', '改寫文字（字面）'],
    ['text-rewrite', '改寫文字（正則）'],
  ];

  const PLACEHOLDERS = {
    hide: { pattern: 'CSS 選擇器，例 .tm-menu', replacement: '（隱藏不需要替換字）' },
    'text-replace': { pattern: '要找的字，例 templatemo', replacement: '換成，例 templatee' },
    'text-rewrite': { pattern: '正則，例 ^(\\d{2,4})\\s+(.+)$', replacement: '例 $2[$1]' },
  };

  const state = {
    /** siteId → 展開了沒 */
    open: new Set(),
    /** siteId → 規則清單（含編譯錯誤） */
    rules: new Map(),
    /** siteId → 資源覆寫清單 */
    resources: new Map(),
    /** siteId → 候選圖 */
    candidates: new Map(),
    /** siteId → 試跑結果 */
    dryRun: new Map(),
    onChanged: () => {},
  };

  /* -------------------------------- 畫面 -------------------------------- */

  function kindOptions(rule) {
    return KINDS.map(
      ([value, label]) =>
        `<option value="${value}"${value === rule.kind ? ' selected' : ''}>${label}</option>`,
    ).join('');
  }

  /** 試跑的結果：這條規則命中幾段 */
  function matchBadge(siteId, rule) {
    const report = state.dryRun.get(siteId);
    if (!report) return '';

    const found = report.rules.find((entry) => entry.id === rule.id);
    if (!found) return '';

    // hide 的數字由瀏覽器數（伺服器回 null）
    const matched = found.matched === null ? found.cssMatched ?? null : found.matched;
    if (matched === null) return '<span class="badge" title="還沒數到">?</span>';

    return matched > 0
      ? `<span class="badge is-ok">命中 ${matched}</span>`
      : '<span class="badge is-bad">0 命中</span>';
  }

  function ruleRow(siteId, rule) {
    const placeholder = PLACEHOLDERS[rule.kind] ?? PLACEHOLDERS.hide;
    const isHide = rule.kind === 'hide';

    return `
      <div class="rule-row${rule.error ? ' has-error' : ''}" data-rule-id="${escapeHtml(rule.id)}">
        <select data-action="rule-kind" class="rule-kind">${kindOptions(rule)}</select>
        <input
          data-action="rule-pattern"
          class="rule-input"
          value="${escapeHtml(rule.pattern)}"
          placeholder="${escapeHtml(placeholder.pattern)}"
          spellcheck="false"
        />
        <input
          data-action="rule-replacement"
          class="rule-input"
          value="${escapeHtml(rule.replacement ?? '')}"
          placeholder="${escapeHtml(placeholder.replacement)}"
          spellcheck="false"
          ${isHide ? 'disabled' : ''}
        />
        <input
          data-action="rule-scope"
          class="rule-input rule-scope"
          value="${escapeHtml(rule.scope ?? '')}"
          placeholder="${isHide ? '（隱藏用不到）' : '限定範圍，例 #footer'}"
          spellcheck="false"
          ${isHide ? 'disabled' : ''}
        />
        <input
          data-action="rule-note"
          class="rule-input rule-note"
          value="${escapeHtml(rule.note ?? '')}"
          placeholder="備註（給人看的）"
        />
        <div class="rule-actions">
          ${matchBadge(siteId, rule)}
          <label class="switch">
            <input type="checkbox" data-action="rule-enabled" ${rule.enabled ? 'checked' : ''} />
            <span>啟用</span>
          </label>
          <button type="button" class="ghost" data-action="rule-save">儲存</button>
          <button type="button" class="ghost" data-action="rule-up" title="往上移">↑</button>
          <button type="button" class="ghost" data-action="rule-down" title="往下移">↓</button>
          <button type="button" class="ghost" data-action="rule-delete" title="刪除">✕</button>
        </div>
        ${rule.error ? `<p class="notice is-bad rule-error">${escapeHtml(rule.error)}</p>` : ''}
      </div>`;
  }

  function resourceRow(resource) {
    const src = `/p/${encodeURIComponent(resource.site_id)}${resource.path}`;

    return `
      <div class="resource-row" data-resource-id="${escapeHtml(resource.id)}">
        <img class="resource-thumb" src="${escapeHtml(src)}" alt="" />
        <code class="resource-path">${escapeHtml(resource.path)}</code>
        <span class="muted">${escapeHtml(resource.content_type)}${
          resource.bytes ? ` · ${Math.ceil(resource.bytes / 1024)} KB` : ''
        }</span>
        <label class="switch">
          <input type="checkbox" data-action="resource-enabled" ${resource.enabled ? 'checked' : ''} />
          <span>啟用</span>
        </label>
        <label class="ghost file-button">
          換掉
          <input type="file" accept="image/*" data-action="resource-replace" hidden />
        </label>
        <button type="button" class="ghost" data-action="resource-delete">✕</button>
      </div>`;
  }

  /** 候選圖：這個站載過哪些圖（規格 §3.6：不要逼使用者自己開 DevTools 抄路徑） */
  function candidateRow(siteId, candidate) {
    const overridden = (state.resources.get(siteId) ?? []).some(
      (resource) => resource.path === candidate.path,
    );

    return `
      <div class="resource-row is-candidate" data-candidate-path="${escapeHtml(candidate.path)}">
        <img class="resource-thumb" src="/p/${encodeURIComponent(siteId)}${escapeHtml(candidate.path)}" alt="" />
        <code class="resource-path">${escapeHtml(candidate.path)}</code>
        <span class="muted">出現 ${candidate.count} 次</span>
        ${
          overridden
            ? '<span class="badge is-ok">已覆寫</span>'
            : `<label class="ghost file-button">
                 換掉這張
                 <input type="file" accept="image/*" data-action="candidate-replace" hidden />
               </label>`
        }
      </div>`;
  }

  function dryRunSummary(siteId) {
    const report = state.dryRun.get(siteId);
    if (!report) return '';

    const warnings = [];
    if (report.charset_ok === false) {
      warnings.push('這一頁沒宣告 UTF-8 → 文字規則整組會被跳過（隱藏規則照舊）');
    }
    if (report.timedOut?.length > 0) {
      warnings.push(`有規則超過時間預算被中止：${report.timedOut.join('、')}`);
    }
    if (report.skippedSegments > 0) {
      warnings.push(`${report.skippedSegments} 段太長，沒餵給正則`);
    }

    return `
      <p class="notice ${warnings.length > 0 ? 'is-warn' : 'is-ok'}">
        試跑 <code>${escapeHtml(report.path)}</code>：改寫了 ${report.applied} 段。
        ${warnings.map((text) => `<br>${escapeHtml(text)}`).join('')}
      </p>`;
  }

  /** 展開後的那一大塊。回字串，由 sites-tab 塞進它自己的 row。 */
  function panel(site) {
    if (!state.open.has(site.id)) return '';

    const rules = state.rules.get(site.id) ?? [];
    const resources = state.resources.get(site.id) ?? [];
    const candidates = state.candidates.get(site.id) ?? [];

    return `
      <div class="site-rules">
        <div class="site-rules-head">
          <strong>改造規則</strong>
          <span class="muted">依序套用；文字規則作用在翻譯後的文字上，而且只動文字段（不碰 href / src / class）</span>
        </div>

        <div class="rule-list">
          ${rules.length === 0 ? '<p class="placeholder">還沒有規則。</p>' : rules.map((rule) => ruleRow(site.id, rule)).join('')}
        </div>

        <div class="rule-toolbar">
          <select data-action="new-kind" class="rule-kind">${kindOptions({ kind: 'hide' })}</select>
          <input data-action="new-pattern" class="rule-input" placeholder="pattern" spellcheck="false" />
          <input data-action="new-replacement" class="rule-input" placeholder="換成" spellcheck="false" />
          <input data-action="new-scope" class="rule-input rule-scope" placeholder="限定範圍（可留空）" spellcheck="false" />
          <button type="button" class="primary" data-action="rule-add">新增規則</button>
          <label class="crawl-option">
            試跑
            <input data-action="dry-run-path" class="rule-input rule-path" value="/" spellcheck="false" />
          </label>
          <button type="button" class="ghost" data-action="rule-dry-run">試一下</button>
        </div>

        ${dryRunSummary(site.id)}

        <div class="site-rules-head">
          <strong>資源覆寫</strong>
          <span class="muted">換 logo / 換圖。只收點陣圖（PNG / JPEG / GIF / WebP…）—— SVG 可以內嵌 script，不收</span>
        </div>

        <div class="resource-list">
          ${resources.length === 0 ? '<p class="placeholder">還沒有覆寫。</p>' : resources.map((resource) => resourceRow(resource)).join('')}
        </div>

        <div class="rule-toolbar">
          <label class="crawl-option">
            掃哪一頁
            <input data-action="candidate-path" class="rule-input rule-path" value="/" spellcheck="false" />
          </label>
          <button type="button" class="ghost" data-action="load-candidates">列出這頁載過的圖</button>
        </div>

        ${candidates.length === 0 ? '' : `<div class="resource-list">${candidates.map((candidate) => candidateRow(site.id, candidate)).join('')}</div>`}
      </div>`;
  }

  /** 清單那一欄的摘要 */
  function summary(site) {
    const expanded = state.open.has(site.id);
    const rules = state.rules.get(site.id);
    const count = rules ? rules.length : site.rule_count ?? 0;
    const broken = rules ? rules.filter((rule) => rule.error).length : 0;

    return `
      <div class="site-sub">
        ${count > 0 ? `<span class="badge is-ok">${count} 條</span>` : '<span class="badge">—</span>'}
        ${broken > 0 ? `<span class="badge is-bad">${broken} 條壞掉</span>` : ''}
        <button type="button" class="ghost" data-action="rules-toggle-panel">
          ${expanded ? '收起' : '規則'}
        </button>
      </div>`;
  }

  /* -------------------------------- 行為 -------------------------------- */

  function rowValue(container, action) {
    return container.querySelector(`[data-action="${action}"]`)?.value ?? '';
  }

  function ruleIdOf(element) {
    return element.closest('[data-rule-id]')?.dataset.ruleId ?? null;
  }

  function ruleFormValues(element) {
    const container = element.closest('[data-rule-id]');
    if (!container) return null;

    return {
      kind: rowValue(container, 'rule-kind'),
      pattern: rowValue(container, 'rule-pattern'),
      replacement: rowValue(container, 'rule-replacement'),
      scope: rowValue(container, 'rule-scope'),
      note: rowValue(container, 'rule-note'),
    };
  }

  async function loadRules(siteId) {
    state.rules.set(siteId, await api.listSiteRules(siteId));
  }

  async function loadResources(siteId) {
    state.resources.set(siteId, await api.listResources(siteId));
  }

  /**
   * `hide` 的命中數：抓一份**代理過的**頁面（同源，所以 fetch 得到），
   * 用 DOMParser 建一棵真的 DOM 再 querySelectorAll。
   *
   * 藏起來的元素還在 DOM 裡（我們藏的是視覺不是結構），所以這個數字在規則
   * 已經生效的頁面上照樣算得對。
   */
  async function countHideMatches(siteId, path) {
    const rules = (state.rules.get(siteId) ?? []).filter(
      (rule) => rule.kind === 'hide' && !rule.error,
    );
    if (rules.length === 0) return new Map();

    const response = await fetch(`/p/${encodeURIComponent(siteId)}${path}`, {
      credentials: 'same-origin',
    });
    const document_ = new DOMParser().parseFromString(await response.text(), 'text/html');

    return rules.reduce((acc, rule) => {
      try {
        return acc.set(rule.id, document_.querySelectorAll(rule.pattern).length);
      } catch {
        // 選擇器瀏覽器也不認（伺服器端的檢查比較寬鬆）→ 留成「不知道」
        return acc;
      }
    }, new Map());
  }

  async function dryRun(siteId, path) {
    const report = await api.dryRunRules(siteId, path);
    const hideCounts = await countHideMatches(siteId, report.path);

    state.dryRun.set(siteId, {
      ...report,
      rules: report.rules.map((rule) => ({ ...rule, cssMatched: hideCounts.get(rule.id) ?? null })),
    });
  }

  function uploadFrom(input) {
    return input.files && input.files.length > 0 ? input.files[0] : null;
  }

  /**
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

    delegate(container, '[data-action="rules-toggle-panel"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      if (state.open.has(site.id)) state.open.delete(site.id);
      else state.open.add(site.id);

      withBanner(async () => {
        if (state.open.has(site.id)) {
          await loadRules(site.id);
          await loadResources(site.id);
        }
        onChanged();
      });
    });

    delegate(container, '[data-action="rule-add"]', 'click', (event, button) => {
      const site = siteOf(button);
      const panelElement = button.closest('.site-rules');
      if (!site || !panelElement) return;

      withBanner(async () => {
        await api.createSiteRule(site.id, {
          kind: rowValue(panelElement, 'new-kind'),
          pattern: rowValue(panelElement, 'new-pattern'),
          replacement: rowValue(panelElement, 'new-replacement'),
          scope: rowValue(panelElement, 'new-scope'),
        });
        await loadRules(site.id);
        banner.show('規則已新增。', 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="rule-save"]', 'click', (event, button) => {
      const site = siteOf(button);
      const values = ruleFormValues(button);
      if (!site || !values) return;

      withBanner(async () => {
        await api.updateSiteRule(site.id, ruleIdOf(button), values);
        await loadRules(site.id);
        banner.show('規則已儲存。', 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="rule-enabled"]', 'change', (event, input) => {
      const site = siteOf(input);
      if (!site) return;

      withBanner(async () => {
        await api.updateSiteRule(site.id, ruleIdOf(input), { enabled: input.checked });
        await loadRules(site.id);
        onChanged();
      });
    });

    delegate(container, '[data-action="rule-delete"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      withBanner(async () => {
        await api.deleteSiteRule(site.id, ruleIdOf(button));
        await loadRules(site.id);
        banner.show('規則已刪除。', 'warn');
        onChanged();
      });
    });

    /** 上下移：整批重排（一條一條改會在中途留下重複的順序） */
    const move = (button, offset) => {
      const site = siteOf(button);
      const ruleId = ruleIdOf(button);
      const rules = site ? state.rules.get(site.id) ?? [] : [];
      const at = rules.findIndex((rule) => rule.id === ruleId);
      const to = at + offset;

      if (at === -1 || to < 0 || to >= rules.length) return;

      const ids = rules.map((rule) => rule.id);
      const reordered = ids.map((id, index) =>
        index === at ? ids[to] : index === to ? ids[at] : id,
      );

      withBanner(async () => {
        state.rules.set(site.id, await api.reorderSiteRules(site.id, reordered));
        onChanged();
      });
    };

    delegate(container, '[data-action="rule-up"]', 'click', (event, button) => move(button, -1));
    delegate(container, '[data-action="rule-down"]', 'click', (event, button) => move(button, 1));

    delegate(container, '[data-action="rule-dry-run"]', 'click', (event, button) => {
      const site = siteOf(button);
      const panelElement = button.closest('.site-rules');
      if (!site || !panelElement) return;

      withBanner(async () => {
        await dryRun(site.id, rowValue(panelElement, 'dry-run-path') || '/');
        onChanged();
      });
    });

    /* ----------------------------- 資源覆寫 ----------------------------- */

    delegate(container, '[data-action="load-candidates"]', 'click', (event, button) => {
      const site = siteOf(button);
      const panelElement = button.closest('.site-rules');
      if (!site || !panelElement) return;

      withBanner(async () => {
        state.candidates.set(
          site.id,
          await api.listResourceCandidates(site.id, rowValue(panelElement, 'candidate-path') || '/'),
        );
        onChanged();
      });
    });

    delegate(container, '[data-action="resource-replace"]', 'change', (event, input) => {
      const site = siteOf(input);
      const resourceId = input.closest('[data-resource-id]')?.dataset.resourceId;
      const resource = (site ? state.resources.get(site.id) ?? [] : []).find(
        (entry) => entry.id === resourceId,
      );
      const file = uploadFrom(input);
      if (!site || !resource || !file) return;

      withBanner(async () => {
        await api.uploadResource(site.id, resource.path, file);
        await loadResources(site.id);
        banner.show(`${resource.path} 已換成新的檔案。`, 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="candidate-replace"]', 'change', (event, input) => {
      const site = siteOf(input);
      const path = input.closest('[data-candidate-path]')?.dataset.candidatePath;
      const file = uploadFrom(input);
      if (!site || !path || !file) return;

      withBanner(async () => {
        await api.uploadResource(site.id, path, file);
        await loadResources(site.id);
        banner.show(`${path} 已換成新的檔案。`, 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="resource-enabled"]', 'change', (event, input) => {
      const site = siteOf(input);
      const resourceId = input.closest('[data-resource-id]')?.dataset.resourceId;
      if (!site || !resourceId) return;

      withBanner(async () => {
        await api.updateResource(site.id, resourceId, input.checked);
        await loadResources(site.id);
        onChanged();
      });
    });

    delegate(container, '[data-action="resource-delete"]', 'click', (event, button) => {
      const site = siteOf(button);
      const resourceId = button.closest('[data-resource-id]')?.dataset.resourceId;
      if (!site || !resourceId) return;

      withBanner(async () => {
        await api.deleteResource(site.id, resourceId);
        await loadResources(site.id);
        banner.show('覆寫已刪除，那條路徑回去走上游。', 'warn');
        onChanged();
      });
    });
  }

  return { init, panel, summary };
})();
