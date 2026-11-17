/* LocalMonkey 控制台：啟動與分頁切換。 */
'use strict';

(function bootstrap() {
  const { byId, banner } = window.LocalMonkeyUi;
  const scriptsTab = window.LocalMonkeyScriptsTab;
  const sitesTab = window.LocalMonkeySitesTab;
  const translateTab = window.LocalMonkeyTranslateTab;
  const settingsTab = window.LocalMonkeySettingsTab;
  const dropScript = window.LocalMonkeyDropScript;

  const PANELS = {
    scripts: 'tab-scripts',
    sites: 'tab-sites',
    translate: 'tab-translate',
    settings: 'tab-settings',
  };

  function showTab(name) {
    for (const button of document.querySelectorAll('.tab')) {
      button.classList.toggle('is-active', button.dataset.tab === name);
    }

    for (const [tab, panelId] of Object.entries(PANELS)) {
      byId(panelId).hidden = tab !== name;
    }

    // 切過去才抓資料：設定是唯讀快照，每次進來都該是最新的
    if (name === 'sites') {
      sitesTab
        .refresh()
        // 爬取工作的進度在 DB 裡，所以切回來就能接上正在跑的那個
        .then(() => sitesTab.hydrate())
        .catch((error) => banner.error(error));
    }
    if (name === 'translate') translateTab.refresh().catch((error) => banner.error(error));
    if (name === 'settings') settingsTab.refresh().catch((error) => banner.error(error));
  }

  byId('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('.tab');
    if (button) showTab(button.dataset.tab);
  });

  dropScript.init({
    onDeployed: async (scriptId) => {
      showTab('scripts');
      await scriptsTab.refresh();
      await scriptsTab.select(scriptId);
      await sitesTab.refresh();
    },
  });

  // 先把伺服器設定抓下來（資訊列要靠它判斷 @connect 會不會被擋），失敗也不要卡住啟動
  const settingsReady = window.LocalMonkeyApi.getSettings()
    .then((settings) => window.LocalMonkeyInfoBar.setSettings(settings))
    .catch(() => {});

  Promise.all([
    settingsReady,
    scriptsTab.init({
      onSitesChanged: () => sitesTab.refresh().catch((error) => banner.error(error)),
    }),
    sitesTab.init(),
    translateTab.init(),
    settingsTab.init(),
  ]).catch((error) => banner.error(error));
})();
