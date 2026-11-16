'use strict';

/**
 * 給人看的錯誤頁。規格明確要求：不要只回「代理請求失敗」，
 * 要寫清楚目標是誰、可能的原因、下一步怎麼做 —— 但不准吐 stack trace。
 */

const ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

const STYLE = [
  'body{font:16px/1.7 system-ui,"Noto Sans TC",sans-serif;margin:0;padding:48px 24px;',
  'background:#0f1115;color:#e6e8eb;display:flex;justify-content:center}',
  'main{max-width:640px;width:100%}',
  'h1{font-size:20px;margin:0 0 8px}',
  '.code{font-size:48px;font-weight:700;color:#f0b429;margin:0;line-height:1}',
  'p{margin:12px 0;color:#c3c8cf}',
  'ul{margin:12px 0;padding-left:20px;color:#c3c8cf}',
  'code{background:#1b1f27;padding:2px 6px;border-radius:4px;color:#8fd3ff;word-break:break-all}',
  'footer{margin-top:32px;font-size:13px;color:#7a828e}',
].join('');

/**
 * @param {{ status: number, title: string, paragraphs?: string[], hints?: string[] }} input
 *        paragraphs / hints 允許內含 <code> 標籤，呼叫端要自己對變數做 escapeHtml
 */
function renderErrorPage({ status, title, paragraphs = [], hints = [] }) {
  const hintBlock =
    hints.length > 0
      ? `<p>常見原因：</p><ul>${hints.map((hint) => `<li>${hint}</li>`).join('')}</ul>`
      : '';

  return [
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
    `<title>${escapeHtml(status)} ${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style></head><body><main>`,
    `<p class="code">${escapeHtml(status)}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    paragraphs.map((text) => `<p>${text}</p>`).join(''),
    hintBlock,
    '<footer>LocalMonkey</footer>',
    '</main></body></html>',
  ].join('');
}

module.exports = { renderErrorPage, escapeHtml };
