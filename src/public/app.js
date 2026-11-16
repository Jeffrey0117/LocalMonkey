/* LocalMonkey 後台：UI。原生 JS、沒有 build step、沒有框架。 */
'use strict';

(function main() {
  const api = window.LocalMonkeyApi;

  const banner = document.getElementById('banner');
  const siteList = document.getElementById('site-list');
  const siteForm = document.getElementById('site-new');
  const scriptsPanel = document.getElementById('scripts-panel');
  const scriptsSiteName = document.getElementById('scripts-site-name');
  const scriptList = document.getElementById('script-list');
  const scriptForm = document.getElementById('script-new');

  let state = { sites: [], selectedSiteId: null, scripts: [] };

  function setState(patch) {
    state = { ...state, ...patch };
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  }

  function notify(message, ok = false) {
    banner.textContent = message;
    banner.className = ok ? 'banner ok' : 'banner';
    banner.hidden = false;
    if (ok) window.setTimeout(() => (banner.hidden = true), 2500);
  }

  function clearBanner() {
    banner.hidden = true;
  }

  async function guard(action, successMessage) {
    try {
      clearBanner();
      await action();
      if (successMessage) notify(successMessage, true);
    } catch (error) {
      if (error.status === 401) {
        notify('後台 token 失效了。請用 /admin?token=<你的 token> 重新進來一次。');
        return;
      }
      notify(error.message);
    }
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function copyText(text, input) {
    try {
      await navigator.clipboard.writeText(text);
      notify('代理網址已複製', true);
    } catch {
      // http 的區網頁面沒有 clipboard API，退回選取讓使用者自己按 Ctrl+C
      input.select();
      notify('這個環境不給程式寫剪貼簿，已幫你選起來，請按 Ctrl+C');
    }
  }

  function proxyUrlRow(site) {
    const url = `${window.location.origin}/p/${site.id}/`;
    const input = el('input', { readonly: 'readonly', value: url });

    return el('div', { class: 'actions wide' }, [
      input,
      el('button', {
        type: 'button',
        class: 'ghost',
        text: '複製',
        onclick: () => copyText(url, input),
      }),
      el('a', { class: 'pill', href: url, target: '_blank', rel: 'noreferrer', text: '開啟 ↗' }),
    ]);
  }

  function siteCard(site) {
    const nameInput = el('input', { value: site.name });
    const originInput = el('input', { value: site.target_origin });

    const save = () =>
      guard(async () => {
        await api.updateSite(site.id, {
          name: nameInput.value,
          target_origin: originInput.value,
        });
        await loadSites();
      }, `已更新「${site.name}」`);

    const toggle = el('input', { type: 'checkbox', ...(site.enabled ? { checked: '' } : {}) });
    toggle.addEventListener('change', () =>
      guard(async () => {
        await api.updateSite(site.id, { enabled: toggle.checked });
        await loadSites();
      }),
    );

    const remove = () =>
      guard(async () => {
        if (!window.confirm(`確定要刪掉「${site.name}」與它所有腳本？`)) return;
        await api.deleteSite(site.id);
        if (state.selectedSiteId === site.id) {
          setState({ selectedSiteId: null, scripts: [] });
          scriptsPanel.hidden = true;
        }
        await loadSites();
      });

    return el('li', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: site.name }),
        el('span', {
          class: site.enabled ? 'pill on' : 'pill',
          text: site.enabled ? '啟用中' : '已停用',
        }),
      ]),
      el('p', { class: 'meta', text: `id: ${site.id} → ${site.target_origin}` }),
      proxyUrlRow(site),
      el('div', { class: 'form grid' }, [
        el('label', { text: '名稱' }, [nameInput]),
        el('label', { text: 'target_origin' }, [originInput]),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', text: '儲存', onclick: save }),
        el('button', {
          type: 'button',
          class: 'ghost',
          text: '管理腳本',
          onclick: () => selectSite(site.id),
        }),
        el('label', { class: 'toggle', text: '啟用' }, [toggle]),
        el('button', { type: 'button', class: 'danger', text: '刪除', onclick: remove }),
      ]),
    ]);
  }

  function scriptCard(script) {
    const name = el('input', { value: script.name });
    const glob = el('input', { value: script.match_glob });
    const order = el('input', { type: 'number', step: '1', value: String(script.order_index) });
    const code = el('textarea', { rows: '8' });
    code.value = script.code;

    const runAt = el('select', {}, [
      el('option', { value: 'body-end', text: 'body-end（頁面結尾）' }),
      el('option', { value: 'head-end', text: 'head-end（head 結尾）' }),
    ]);
    runAt.value = script.run_at;

    const enabled = el('input', { type: 'checkbox', ...(script.enabled ? { checked: '' } : {}) });

    const save = () =>
      guard(async () => {
        await api.updateScript(script.id, {
          name: name.value,
          code: code.value,
          match_glob: glob.value,
          run_at: runAt.value,
          order_index: Number(order.value),
          enabled: enabled.checked,
        });
        await loadScripts();
      }, `已儲存「${script.name}」`);

    const remove = () =>
      guard(async () => {
        if (!window.confirm(`確定要刪掉腳本「${script.name}」？`)) return;
        await api.deleteScript(script.id);
        await loadScripts();
      });

    return el('li', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: script.name }),
        el('span', {
          class: script.enabled ? 'pill on' : 'pill',
          text: script.enabled ? '啟用中' : '已停用',
        }),
      ]),
      el('div', { class: 'form grid' }, [
        el('label', { text: '名稱' }, [name]),
        el('label', { text: '執行時機' }, [runAt]),
        el('label', { text: 'match_glob' }, [glob]),
        el('label', { text: '順序（小的先跑）' }, [order]),
        el('label', { class: 'wide', text: '程式碼' }, [code]),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', text: '儲存', onclick: save }),
        el('label', { class: 'toggle', text: '啟用' }, [enabled]),
        el('button', { type: 'button', class: 'danger', text: '刪除', onclick: remove }),
      ]),
      el('p', { class: 'meta', text: `id: ${script.id}` }),
    ]);
  }

  function renderSites() {
    siteList.replaceChildren(
      ...(state.sites.length === 0
        ? [el('li', { class: 'empty', text: '還沒有任何網站。按上面的「新增網站」開始。' })]
        : state.sites.map((site) => siteCard(site))),
    );
  }

  function renderScripts() {
    const site = state.sites.find((candidate) => candidate.id === state.selectedSiteId);
    scriptsSiteName.textContent = site ? site.name : '';
    scriptList.replaceChildren(
      ...(state.scripts.length === 0
        ? [el('li', { class: 'empty', text: '這個網站還沒有腳本。' })]
        : state.scripts.map((script) => scriptCard(script))),
    );
  }

  async function loadSites() {
    setState({ sites: await api.listSites() });
    renderSites();
    if (state.selectedSiteId) renderScripts();
  }

  async function loadScripts() {
    setState({ scripts: await api.listScripts(state.selectedSiteId) });
    renderScripts();
  }

  function selectSite(siteId) {
    setState({ selectedSiteId: siteId });
    scriptsPanel.hidden = false;
    guard(async () => {
      await loadScripts();
      scriptsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function wireToggle(buttonId, form) {
    document.getElementById(buttonId).addEventListener('click', () => {
      form.hidden = !form.hidden;
    });
  }

  siteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(siteForm);
    guard(async () => {
      await api.createSite(values);
      siteForm.reset();
      siteForm.hidden = true;
      await loadSites();
    }, `已建立「${values.name}」`);
  });

  scriptForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(scriptForm);
    guard(async () => {
      await api.createScript(state.selectedSiteId, {
        ...values,
        order_index: Number(values.order_index),
      });
      scriptForm.reset();
      scriptForm.hidden = true;
      await loadScripts();
    }, `已建立腳本「${values.name}」`);
  });

  wireToggle('site-new-toggle', siteForm);
  wireToggle('script-new-toggle', scriptForm);

  guard(loadSites);
})();
