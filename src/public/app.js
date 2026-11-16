/* LocalMonkey 控制台：啟動與分頁切換。 */
'use strict';

(function bootstrap() {
  const { byId, banner } = window.LocalMonkeyUi;
  const scriptsTab = window.LocalMonkeyScriptsTab;
  const sitesTab = window.LocalMonkeySitesTab;
  const dropScript = window.LocalMonkeyDropScript;

  function showTab(name) {
    for (const button of document.querySelectorAll('.tab')) {
      button.classList.toggle('is-active', button.dataset.tab === name);
    }

    byId('tab-scripts').hidden = name !== 'scripts';
    byId('tab-sites').hidden = name !== 'sites';

    if (name === 'sites') sitesTab.refresh().catch((error) => banner.error(error));
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
  ]).catch((error) => banner.error(error));
})();
