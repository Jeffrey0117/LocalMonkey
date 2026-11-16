/*
 * 唯讀資訊列：把解析結果畫出來。
 *
 * 這一列**不是輸入**。配對、權限、時機全部寫在 userscript header 裡，
 * 所以這裡只負責顯示，而且跟著打字即時更新 —— header 是唯一真相來源。
 */
'use strict';

window.LocalMonkeyInfoBar = (function createInfoBar() {
  const { escapeHtml } = window.LocalMonkeyUi;

  // 伺服器的 GM 白名單（由 app.js 在啟動時灌進來）。沒拿到就當空的。
  const state = { gmAllowHosts: [] };

  function setSettings(settings) {
    state.gmAllowHosts = Array.isArray(settings?.gmAllowHosts) ? settings.gmAllowHosts : [];
  }

  /** 字面上的本機位址（跟 src/lib/gm-allow-hosts.js 的 looksLoopback 同一組規則） */
  function looksLoopback(host) {
    const hostname = String(host ?? '').toLowerCase().split(':')[0];
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname)) return true;
    return hostname.startsWith('127.') || hostname.endsWith('.localhost');
  }

  function isCovered(host) {
    const declared = String(host ?? '').toLowerCase().split(':')[0];
    return state.gmAllowHosts.some((entry) => String(entry).toLowerCase().split(':')[0] === declared);
  }

  /** 會被 SSRF 擋掉的 @connect 主機 → 要在權限列紅字講出來，不能靜默失敗 */
  function connectBlocked(host) {
    return looksLoopback(host) && !isCovered(host);
  }

  const STATUS_LABEL = { ready: '可代理', 'needs-host': '要指定主機', rejected: '不能用' };
  const STATUS_CLASS = { ready: 'ok', 'needs-host': 'warn', rejected: 'bad' };

  function badge(status) {
    return `<span class="badge is-${STATUS_CLASS[status] ?? 'warn'}">${escapeHtml(
      STATUS_LABEL[status] ?? status,
    )}</span>`;
  }

  function row(label, html) {
    return `<div class="info-cell"><span class="info-label">${escapeHtml(label)}</span><span class="info-value">${html}</span></div>`;
  }

  function matchesHtml(parsed) {
    if (parsed.targets.length === 0) {
      return '<span class="muted">沒有 @match / @include —— 這支不會掛在任何網站上</span>';
    }

    return parsed.targets
      .map((target) => {
        const host = target.host ?? target.pattern;
        const path = target.pathGlob && target.pathGlob !== '*' ? `<span class="muted">${escapeHtml(target.pathGlob)}</span>` : '';
        const note = target.proxyable === 'ready' ? '' : badge(target.proxyable);
        const title = target.reason ?? target.warning ?? '';

        return `<span class="chip" title="${escapeHtml(title)}">${escapeHtml(host)} ${path} ${note}${
          target.insecure ? '<span class="badge is-warn">http</span>' : ''
        }</span>`;
      })
      .join('');
  }

  function grantsHtml(parsed) {
    if (parsed.grantNone) return '<span class="muted">@grant none —— 不注入 GM shim</span>';
    if (parsed.grants.length === 0) return '<span class="muted">沒有 @grant</span>';

    const unsupported = new Set(parsed.unsupportedGrants);

    return parsed.grants
      .map((grant) =>
        unsupported.has(grant)
          ? `<span class="chip is-bad" title="LocalMonkey 尚未支援，呼叫時會在 console 報錯">${escapeHtml(grant)} ✕</span>`
          : `<span class="chip">${escapeHtml(grant)} ✓</span>`,
      )
      .join('');
  }

  function extrasHtml(parsed) {
    const parts = [];

    if (parsed.connectAll) {
      parts.push('<span class="chip is-bad" title="請改成列出具體主機">@connect * ✕</span>');
    } else if (parsed.connect.length > 0) {
      parts.push(
        parsed.connect
          .map((host) =>
            connectBlocked(host)
              ? `<span class="chip is-bad" title="這是本機位址，但沒有加進 LOCALMONKEY_GM_ALLOW_HOSTS —— GM_xmlhttpRequest 會被擋掉（靜默失敗）。請設成例如 LOCALMONKEY_GM_ALLOW_HOSTS=${escapeHtml(host)}:8001 再重啟。">@connect ${escapeHtml(host)} ✕ 未放行</span>`
              : `<span class="chip">${escapeHtml(host)}</span>`,
          )
          .join(''),
      );
    }

    for (const url of parsed.requires) {
      parts.push(`<span class="chip" title="${escapeHtml(url)}">@require</span>`);
    }
    for (const resource of parsed.resources) {
      parts.push(`<span class="chip" title="${escapeHtml(resource.url)}">@resource ${escapeHtml(resource.name)}</span>`);
    }
    if (parsed.noframes) parts.push('<span class="chip">@noframes</span>');

    return parts.length > 0 ? parts.join('') : '<span class="muted">—</span>';
  }

  /**
   * 伺服器端回報的「這支腳本實際抓到的資產」。解析結果看不出抓失敗，
   * 所以掛掉的 @require 要靠已存檔的 metadata 才顯示得出來。
   */
  function assetsHtml(metadata) {
    const assets = [
      ...(metadata?.requireAssets ?? []),
      ...(metadata?.resourceAssets ?? []),
    ].filter((asset) => asset && asset.sha256 === null);

    if (assets.length === 0) return '';

    return row(
      '失效',
      assets
        .map((asset) => `<span class="chip is-bad" title="${escapeHtml(asset.error ?? '')}">${escapeHtml(asset.url)}</span>`)
        .join(''),
    );
  }

  function noticesHtml(parsed) {
    const notices = parsed.notices.filter((notice) => notice.level === 'error');
    if (notices.length === 0) return '';

    return `<div class="info-notices">${notices
      .map((notice) => `<p class="notice is-bad">${escapeHtml(notice.message)}</p>`)
      .join('')}</div>`;
  }

  /**
   * @param {HTMLElement} container
   * @param {object} parsed POST /admin/api/userscript/parse 的結果
   * @param {object} [metadata] 已存檔的 metadata（用來顯示抓失敗的資產）
   */
  function render(container, parsed, metadata) {
    if (!parsed) {
      container.innerHTML = '<div class="info-cell"><span class="muted">解析中…</span></div>';
      return;
    }

    container.innerHTML = [
      row('配對', matchesHtml(parsed)),
      row('權限', grantsHtml(parsed)),
      row('時機', `<span class="chip">${escapeHtml(parsed.runAt)}</span>`),
      row('其他', extrasHtml(parsed)),
      assetsHtml(metadata),
      noticesHtml(parsed),
    ].join('');
  }

  return { render, badge, setSettings, connectBlocked, STATUS_LABEL };
})();
