/*
 * 「網站」分頁裡每一站展開來的**重繪設定**（SPEC-reskin §6）。
 *
 * 四塊：開關、版型、抽取設定（JSON）、價格方案。
 *
 * ⛔ 這一塊的重點跟改造規則一樣是「**試一下**」—— 寫抽取規則最怕的是
 * 「寫了沒反應」，而「沒反應」至少有五種完全不同的原因：沒開、沒有設定、
 * 設定編不過、這個路徑沒有任何一筆命中、命中了但選擇器配不到東西。
 * 看起來全都一樣（頁面長得跟原本一模一樣），所以試跑一定要把**是哪一種**
 * 講出來，而且要顯示每個欄位實際抽到什麼。
 *
 * 單獨一個檔案的理由同 site-rules.js / site-translate.js：
 * sites-tab.js 不該變成什麼都做的大檔案。
 */
'use strict';

window.LocalMonkeySiteReskin = (function createSiteReskin() {
  const { escapeHtml, banner, delegate } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;

  /** 試跑失敗的五種原因，各自對應一句「所以你該做什麼」 */
  const REASONS = {
    'no-config': ['還沒有抽取設定', '按「套用預設設定」或自己寫一份。'],
    'bad-config': ['設定編不過', '下面的錯誤訊息會指出是哪一筆、哪個欄位。'],
    'no-match': [
      '沒有任何一筆設定管這個路徑',
      '這是正常的 —— 像 /about 這種頁面本來就該走代理模式。要重繪就加一筆 match 對得上的設定。',
    ],
    'extract-failed': ['命中了，但抽不到東西', '選擇器跟這一頁對不上，下面有細節。'],
  };

  const state = {
    /** siteId → 展開了沒 */
    open: new Set(),
    /** siteId → 伺服器回的狀態 */
    status: new Map(),
    /** siteId → 最近一次試跑的結果 */
    tried: new Map(),
    /**
     * siteId → 要試跑哪個路徑。
     *
     * ⛔ 存在 state 裡而不是只留在 input 上：每次試跑完都會 `render()`（面板是
     * 整塊重畫的），輸入框會跟著被重建 —— 使用者打的 `/page/1` 會彈回 `/`，
     * 而下一次按「試一下」就悄悄換成試首頁了。
     */
    path: new Map(),
    /**
     * siteId → 編輯中但還沒存的設定。
     *
     * ⛔ 同一個理由，而且後果更嚴重：「試一下」會 `render()`，而 textarea 的
     * 內容是從**存好的**設定畫出來的 —— 沒有這份草稿的話，使用者改了設定、
     * 按「試一下」看結果，改的東西就在那一瞬間被存檔版蓋掉了。
     * 存檔成功之後才清掉草稿。
     */
    draft: new Map(),
    /** 改了站本身的欄位（reskin_enabled / reskin_theme）之後要重抓清單 */
    onSiteChanged: () => {},
    onChanged: () => {},
  };

  /* -------------------------------- 畫面 -------------------------------- */

  function themeOptions(status) {
    return (status.themes ?? [])
      .map(
        (theme) =>
          `<option value="${escapeHtml(theme.id)}" ${theme.id === status.theme ? 'selected' : ''}>
             ${escapeHtml(theme.label)}
           </option>`,
      )
      .join('');
  }

  /**
   * 金流（SPEC-reskin-v2 §8）。
   *
   * ⛔ 這一格的存在理由是「**半套設定**」：env 少設一個的時候，站是 200、
   * 畫面一切正常，而「立即購買」悄悄退回示範模式 —— 從外面看不出差別。
   * 所以缺哪幾個環境變數要直接列出來，而不是只說「沒接」。
   */
  function paymentBadge(status) {
    const payments = status.payments ?? { live: false, missing: [] };
    if (payments.live) return '<span class="badge is-ok">金流：測試環境已接上</span>';

    const missing = payments.missing ?? [];
    const hint =
      missing.length > 0 && missing.length < 4 ? `（缺 ${missing.join('、')}）` : '';

    return `<span class="badge" title="${escapeHtml(
      missing.join(' '),
    )}">金流：示範模式${escapeHtml(hint)}</span>`;
  }

  function pricingRows(status) {
    return (status.pricing?.plans ?? [])
      .map(
        (plan, index) => `
        <tr data-plan-index="${index}">
          <td><input data-field="id" value="${escapeHtml(plan.id)}" spellcheck="false"></td>
          <td><input data-field="name" value="${escapeHtml(plan.name)}"></td>
          <td><input data-field="price" type="number" min="0" value="${escapeHtml(plan.price)}"></td>
          <td><input data-field="note" value="${escapeHtml(plan.note ?? '')}"></td>
        </tr>`,
      )
      .join('');
  }

  /** 試跑結果。**抽到什麼**比「成功了」有用得多，所以直接把樣本印出來。 */
  function tryResult(siteId) {
    const result = state.tried.get(siteId);
    if (!result) return '';

    if (result.pending) return '<div class="reskin-try muted">試跑中…</div>';

    if (!result.ok) {
      const [title, hint] = REASONS[result.reason] ?? ['試跑失敗', ''];
      return `
        <div class="reskin-try is-bad">
          <strong>${escapeHtml(title)}</strong>
          <div class="muted">${escapeHtml(hint)}</div>
          ${result.error ? `<pre>${escapeHtml(result.error)}</pre>` : ''}
          ${
            result.charset_ok === false
              ? '<div class="muted">另外：這份文件沒有明確宣告 UTF-8，所以就算設定對了也不會重繪（版型是中文的）。</div>'
              : ''
          }
        </div>`;
    }

    const sample = JSON.stringify(result.sample, null, 2);

    return `
      <div class="reskin-try is-ok">
        <strong>第 ${escapeHtml(result.matched + 1)} 筆設定命中・${escapeHtml(result.kind)}・抽到 ${escapeHtml(result.items)} 項</strong>
        <div class="muted">
          ${
            result.page
              ? `分頁：第 ${escapeHtml(result.page.page ?? '?')} / ${escapeHtml(result.page.totalPages ?? '?')} 頁・`
              : ''
          }分類 ${escapeHtml(result.categories)} 個
        </div>
        <pre>${escapeHtml(sample)}</pre>
      </div>`;
  }

  function panel(site) {
    if (!state.open.has(site.id)) return '';

    const status = state.status.get(site.id);
    if (!status) return '<div class="site-rules"><span class="muted">載入中…</span></div>';

    return `
      <div class="site-rules site-reskin">
        <div class="site-rules-head">
          <strong>重繪（把上游當資料來源，用我們自己的版型重畫）</strong>
          <span class="muted">
            抽取設定綁著上游的 DOM，換資料來源就整份換掉；版型完全不知道上游是誰。
            沒有任何一筆設定命中的路徑會**照舊走代理模式**。
          </span>
        </div>

        <div class="reskin-controls">
          <label class="switch">
            <input type="checkbox" data-action="reskin-toggle" ${status.enabled ? 'checked' : ''}>
            <span>${status.enabled ? '重繪中' : '沒開'}</span>
          </label>

          <label class="reskin-theme">
            版型
            <select data-action="reskin-theme">${themeOptions(status)}</select>
          </label>

          ${paymentBadge(status)}

          <span class="badge ${status.entries > 0 ? 'is-ok' : ''}">${escapeHtml(status.entries)} 筆設定</span>
          <span class="badge">${escapeHtml(status.cached)} 筆快取</span>
          <button type="button" class="ghost" data-action="reskin-clear-cache">清掉快取</button>
          ${
            status.has_preset
              ? '<button type="button" class="ghost" data-action="reskin-preset">套用預設設定</button>'
              : ''
          }
        </div>

        ${
          status.config_error
            ? `<div class="reskin-try is-bad"><strong>設定編不過</strong><pre>${escapeHtml(status.config_error)}</pre></div>`
            : ''
        }

        <div class="reskin-grid">
          <div>
            <label class="reskin-label" for="reskin-config-${escapeHtml(site.id)}">
              抽取設定（JSON 陣列，順序就是比對順序，第一個命中的勝出）
            </label>
            <textarea id="reskin-config-${escapeHtml(site.id)}" class="reskin-config"
                      data-action="reskin-config" spellcheck="false"
                      rows="14">${escapeHtml(state.draft.get(site.id) ?? status.config ?? '')}</textarea>
            <div class="site-actions">
              <button type="button" data-action="reskin-save">存設定</button>
              <input class="reskin-path" data-action="reskin-path" spellcheck="false"
                     value="${escapeHtml(state.path.get(site.id) ?? '/')}"
                     aria-label="要試跑的路徑">
              <button type="button" class="ghost" data-action="reskin-try">試一下</button>
            </div>
            <div class="muted">
              選擇器語法跟規則的「限定範圍」同一套：<code>tag</code> / <code>.class</code> /
              <code>#id</code> / <code>*</code> 與空白、<code>&gt;</code> 組合子。
              每個欄位可以有 <code>sel</code>、<code>attr</code>（<code>text</code> 或屬性名）、
              <code>as</code>（<code>text</code>/<code>url</code>/<code>number</code>/<code>link</code>）、
              <code>many</code>、<code>when</code>、<code>extract</code>。
            </div>
            ${tryResult(site.id)}
          </div>

          <div>
            <label class="reskin-label">
              價格方案（上游沒有價格，這是我們自己定的。接了金流的時候，真正被扣的錢
              在 PayGate 的方案裡 —— 這裡的數字只是印在畫面上）
            </label>
            <table class="reskin-pricing">
              <thead><tr><th>id</th><th>名稱</th><th>價格</th><th>說明</th></tr></thead>
              <tbody data-reskin-plans>${pricingRows(status)}</tbody>
            </table>
            <div class="site-actions">
              <button type="button" data-action="reskin-save-pricing">存價格</button>
              <button type="button" class="ghost" data-action="reskin-reset-pricing">回到預設</button>
            </div>
            ${
              status.pricing_error
                ? `<div class="reskin-try is-bad"><pre>${escapeHtml(status.pricing_error)}</pre></div>`
                : ''
            }
          </div>
        </div>
      </div>`;
  }

  function summary(site) {
    const expanded = state.open.has(site.id);
    const status = state.status.get(site.id);

    const badge = site.reskin_enabled
      ? `<span class="badge is-ok">重繪中</span>`
      : '<span class="badge">—</span>';

    return `
      <div class="site-sub">
        ${badge}
        ${status?.config_error ? '<span class="badge is-bad">設定壞掉</span>' : ''}
        <button type="button" class="ghost" data-action="reskin-toggle-panel">
          ${expanded ? '收起' : '重繪'}
        </button>
      </div>`;
  }

  /* -------------------------------- 行為 -------------------------------- */

  function panelOf(element) {
    return element.closest('.site-reskin');
  }

  function configOf(element) {
    return panelOf(element)?.querySelector('[data-action="reskin-config"]')?.value ?? '';
  }

  function pathOf(element) {
    const value = panelOf(element)?.querySelector('[data-action="reskin-path"]')?.value ?? '/';
    return value.startsWith('/') ? value : `/${value}`;
  }

  /** 價格表格 → `compilePricing` 吃得下的形狀 */
  function readPricing(element, status) {
    const rows = [...(panelOf(element)?.querySelectorAll('[data-plan-index]') ?? [])];

    return {
      currency: status.pricing?.currency ?? 'NT$',
      plans: rows.map((row) => ({
        id: row.querySelector('[data-field="id"]').value.trim(),
        name: row.querySelector('[data-field="name"]').value.trim(),
        price: Number(row.querySelector('[data-field="price"]').value),
        note: row.querySelector('[data-field="note"]').value.trim(),
      })),
    };
  }

  async function load(siteId) {
    state.status.set(siteId, await api.getReskin(siteId));
    state.onChanged();
  }

  function withErrorBanner(siteId, action) {
    return (async () => {
      try {
        await action();
      } catch (error) {
        banner.error(error);
        await load(siteId);
      }
    })();
  }

  function init(container, { siteOf, onChanged, onSiteChanged }) {
    state.onChanged = onChanged;
    state.onSiteChanged = onSiteChanged;

    delegate(container, '[data-action="reskin-toggle-panel"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      if (state.open.has(site.id)) {
        state.open.delete(site.id);
        onChanged();
        return;
      }

      state.open.add(site.id);
      onChanged();
      withErrorBanner(site.id, () => load(site.id));
    });

    // 打字就記進草稿（面板隨時可能被重畫，見 state.draft 的註解）
    delegate(container, '[data-action="reskin-config"]', 'input', (event, textarea) => {
      const site = siteOf(textarea);
      if (site) state.draft.set(site.id, textarea.value);
    });

    delegate(container, '[data-action="reskin-toggle"]', 'change', (event, input) => {
      const site = siteOf(input);
      if (!site) return;

      withErrorBanner(site.id, async () => {
        await api.updateSite(site.id, { reskin_enabled: input.checked });
        banner.show(`${site.id} 的重繪已${input.checked ? '打開' : '關掉'}。`, 'ok');
        await load(site.id);
        // 開關存在 site 上，所以要重抓清單（不然摘要那格會彈回舊值）
        state.onSiteChanged();
      });
    });

    delegate(container, '[data-action="reskin-theme"]', 'change', (event, select) => {
      const site = siteOf(select);
      if (!site) return;

      withErrorBanner(site.id, async () => {
        await api.updateSite(site.id, { reskin_theme: select.value });
        banner.show(`版型換成 ${select.value}。`, 'ok');
        await load(site.id);
        state.onSiteChanged();
      });
    });

    delegate(container, '[data-action="reskin-save"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      const config = configOf(button);
      withErrorBanner(site.id, async () => {
        const saved = await api.saveReskinConfig(site.id, config);
        state.status.set(site.id, saved);
        state.draft.delete(site.id);
        banner.show(
          saved.config_error
            ? `存好了，但設定編不過：${saved.config_error}`
            : `存好了（${saved.entries} 筆設定），順手清掉了 ${saved.cache_cleared} 筆快取。`,
          saved.config_error ? 'warn' : 'ok',
        );
        onChanged();
      });
    });

    delegate(container, '[data-action="reskin-preset"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      withErrorBanner(site.id, async () => {
        const saved = await api.applyReskinPreset(site.id);
        state.status.set(site.id, saved);
        // preset 是整份取代，草稿留著只會讓畫面跟實際生效的那份不一樣
        state.draft.delete(site.id);
        banner.show(`套上了預設的抽取設定（${saved.entries} 筆）。`, 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="reskin-clear-cache"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      withErrorBanner(site.id, async () => {
        const { cleared } = await api.clearReskinCache(site.id);
        banner.show(`清掉 ${cleared} 筆抽取快取。`, 'ok');
        await load(site.id);
      });
    });

    delegate(container, '[data-action="reskin-try"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      const path = pathOf(button);
      const config = configOf(button);

      state.path.set(site.id, path);
      state.tried.set(site.id, { pending: true });
      onChanged();

      withErrorBanner(site.id, async () => {
        state.tried.set(site.id, await api.dryRunReskin(site.id, { path, config }));
        onChanged();
      });
    });

    delegate(container, '[data-action="reskin-save-pricing"]', 'click', (event, button) => {
      const site = siteOf(button);
      const status = state.status.get(site?.id);
      if (!site || !status) return;

      withErrorBanner(site.id, async () => {
        state.status.set(site.id, await api.saveReskinPricing(site.id, readPricing(button, status)));
        banner.show('價格方案存好了。', 'ok');
        onChanged();
      });
    });

    delegate(container, '[data-action="reskin-reset-pricing"]', 'click', (event, button) => {
      const site = siteOf(button);
      if (!site) return;

      withErrorBanner(site.id, async () => {
        state.status.set(site.id, await api.saveReskinPricing(site.id, null));
        banner.show('價格方案回到預設。', 'ok');
        onChanged();
      });
    });
  }

  return { init, panel, summary };
})();
