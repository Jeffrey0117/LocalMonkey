'use strict';

/**
 * 夠用就好的 logger。存在的理由是：讓「正式的 log」與「隨手 console.log 的 debug 殘骸」
 * 在程式碼裡長得不一樣，review 時一眼就看得出來哪個該留。
 */

const LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });

function timestamp() {
  return new Date().toISOString();
}

function createLogger({ level = 'info', out = process.stdout, err = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (stream, label, args) => {
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : formatValue(arg)))
      .join(' ');
    stream.write(`${timestamp()} ${label} ${line}\n`);
  };

  return {
    level,
    info: (...args) => {
      if (threshold >= LEVELS.info) write(out, '[info ]', args);
    },
    warn: (...args) => {
      if (threshold >= LEVELS.warn) write(err, '[warn ]', args);
    },
    error: (...args) => {
      if (threshold >= LEVELS.error) write(err, '[error]', args);
    },
    debug: (...args) => {
      if (threshold >= LEVELS.debug) write(out, '[debug]', args);
    },
  };
}

function formatValue(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const silentLogger = Object.freeze({
  level: 'silent',
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});

module.exports = { createLogger, silentLogger, LEVELS };
