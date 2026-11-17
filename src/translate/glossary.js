'use strict';

/**
 * 術語保護：不准翻的詞。
 *
 * 兩個用途：
 *   1. 整段剛好就是一個術語 → 不送去翻（`rules.js` 用 `isGlossaryTerm`）
 *   2. 段落裡含有術語 → 放進 prompt 的保留清單（`prompt.js` 用 `containsTerm`）
 */

/** 規格 §7 點名的那些，加上同類型的常見詞 */
const DEFAULT_GLOSSARY = Object.freeze([
  'HTML',
  'CSS',
  'JS',
  'JavaScript',
  'TypeScript',
  'Bootstrap',
  'Tailwind',
  'React',
  'Vue',
  'Node.js',
  'AI',
  'API',
  'URL',
  'SEO',
  'HTTP',
  'HTTPS',
  'JSON',
  'SQL',
  'PHP',
  'Python',
  'Claude',
  'ChatGPT',
  'GitHub',
]);

const MAX_TERMS = 500;
const MAX_TERM_LENGTH = 80;

function escapeForRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 吃陣列，也吃 UI 那個「一行一個詞」的 textarea。
 * 去重不分大小寫，保留第一次出現的寫法（使用者打的大小寫就是他要的）。
 */
function normalizeGlossary(input) {
  const raw = typeof input === 'string' ? input.split(/\r?\n/) : Array.isArray(input) ? input : [];

  const { terms } = raw.reduce(
    (acc, entry) => {
      if (typeof entry !== 'string') return acc;

      const term = entry.trim();
      const key = term.toLowerCase();
      if (term.length === 0 || term.length > MAX_TERM_LENGTH) return acc;
      if (acc.seen.has(key)) return acc;

      return { seen: new Set([...acc.seen, key]), terms: [...acc.terms, term] };
    },
    { seen: new Set(), terms: [] },
  );

  return terms.slice(0, MAX_TERMS);
}

/** DB 欄位是 JSON 陣列。被手改壞也不准丟錯 —— 回空的就好。 */
function parseGlossary(json) {
  if (typeof json !== 'string' || json.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? normalizeGlossary(parsed) : [];
  } catch {
    return [];
  }
}

function serializeGlossary(terms) {
  return JSON.stringify(normalizeGlossary(terms));
}

function isGlossaryTerm(text, glossary = []) {
  if (typeof text !== 'string') return false;

  const needle = text.trim().toLowerCase();
  return glossary.some((term) => String(term).trim().toLowerCase() === needle);
}

/**
 * 句子裡有沒有這個術語。
 *
 * ⛔ 要整個詞才算：子字串比對會讓 `AI` 命中 `Maintain`、`API` 命中 `Rapid`，
 * 於是幾乎每一段都會帶著一串假的「請保留」指示去煩模型。
 *
 * 術語裡的 `.`、`+` 要跳脫（`Node.js`、`C++` 都是真的會出現的術語）。
 */
function containsTerm(text, glossary = []) {
  if (typeof text !== 'string' || text.length === 0) return false;

  return glossary.some((term) => {
    const trimmed = String(term).trim();
    if (trimmed.length === 0) return false;

    // 詞邊界自己做：`\b` 對 `Node.js`、`C++` 這種結尾不是字母的詞沒用
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeForRegExp(trimmed)}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    return pattern.test(text);
  });
}

/** 一段文字裡用到的術語（給 prompt 的保留清單，順序照術語表） */
function termsIn(text, glossary = []) {
  return glossary.filter((term) => containsTerm(text, [term]));
}

module.exports = {
  DEFAULT_GLOSSARY,
  normalizeGlossary,
  parseGlossary,
  serializeGlossary,
  isGlossaryTerm,
  containsTerm,
  termsIn,
  MAX_TERMS,
  MAX_TERM_LENGTH,
};
