/*
 * 「設定」分頁（SPEC-dashboard §2.4）。
 *
 * ⛔ 刻意做成**唯讀**。這些全部是環境變數，改了要重啟才生效 ——
 * 做成輸入框等於騙使用者「在這裡改就會生效」。所以每一項都附上對應的
 * 環境變數名稱，要改就去改啟動環境。
 */
'use strict';

window.LocalMonkeySettingsTab = (function createSettingsTab() {
  const { escapeHtml, byId, banner } = window.LocalMonkeyUi;
  const api = window.LocalMonkeyApi;

  /**
   * 每一列：顯示名稱、怎麼從 settings 取值、對應的環境變數。
   * 環境變數名稱寫死在這裡是刻意的 —— 它是給人看的說明，不是伺服器狀態。
   */
  const ROWS = [
    {
      label: '監聽埠',
      env: 'PORT',
      value: (settings) => settings.port,
    },
    {
      label: '監聽位址',
      env: 'HOST',
      value: (settings) => settings.host,
      note: '預設只綁 127.0.0.1 —— 這是本機工具，不要對外開。',
    },
    {
      label: '資料庫',
      env: 'LOCALMONKEY_DATA_DIR',
      value: (settings) => settings.databaseFile,
      mono: true,
    },
    {
      label: '後台 token 檔',
      env: 'LOCALMONKEY_ADMIN_TOKEN',
      value: (settings) => settings.adminTokenFile,
      mono: true,
      note: '設了環境變數就以它為準，這個檔案不會被讀。',
    },
    {
      label: '允許代理內網位址',
      env: 'LOCALMONKEY_ALLOW_PRIVATE',
      value: (settings) => (settings.allowPrivate ? '是（=1）' : '否'),
      note: '關著的時候，解析到內網 / loopback 的目標一律擋下。',
    },
    {
      label: 'GM_xmlhttpRequest 白名單',
      env: 'LOCALMONKEY_GM_ALLOW_HOSTS',
      value: (settings) =>
        settings.gmAllowHosts.length > 0 ? settings.gmAllowHosts.join('、') : '（空的）',
      mono: true,
      note: '只影響 GM_xmlhttpRequest，精確比對 host:port，而且 @connect 還是要過。',
    },
  ];

  function cell(row, settings) {
    const value = row.value(settings);
    const text = value === null || value === undefined || value === '' ? '—' : String(value);

    return `
      <tr>
        <td>
          ${escapeHtml(row.label)}
          ${row.note ? `<span class="row-sub">${escapeHtml(row.note)}</span>` : ''}
        </td>
        <td class="${row.mono ? 'mono' : ''}">${escapeHtml(text)}</td>
        <td><code>${escapeHtml(row.env)}</code></td>
      </tr>`;
  }

  async function refresh() {
    try {
      const settings = await api.getSettings();
      byId('settings-rows').innerHTML = ROWS.map((row) => cell(row, settings)).join('');
    } catch (error) {
      banner.error(error);
    }
  }

  return { init: refresh, refresh };
})();
