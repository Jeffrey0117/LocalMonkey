#!/usr/bin/env node
'use strict';

/**
 * 把一組預設規則配到某個站上（SPEC-rules §3）。
 *
 *   node scripts/seed-site-rules.js templatemo-com
 *   node scripts/seed-site-rules.js templatemo-com --logo path/to/new-logo.png
 *   node scripts/seed-site-rules.js templatemo-com --data-dir C:\tmp\lm-data --dry
 *
 * **直接操作 DB，不需要起 server、也不需要 admin token。** SQLite 是 WAL
 * 模式，所以正在跑的 server 開著同一個檔案也沒問題 —— 規則是每個請求重讀的，
 * 下一次載入就生效。
 *
 * 冪等：同一個 preset 跑兩次不會長出兩份規則（`applyPreset` 比對
 * kind + pattern + scope），所以之後 preset 加了新規則就重跑一次。
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/config.js');
const { openDatabase } = require('../src/db/index.js');
const { createStore } = require('../src/db/store.js');
const { PRESETS, applyPreset, TEMPLATEMO_LOGO_PATH } = require('../src/rules/presets/index.js');
const { compileRules } = require('../src/rules/compile.js');
const { validateResourceUpload } = require('../src/lib/validate-rules.js');

function parseArgs(argv) {
  return argv.reduce(
    (acc, value, index, all) => {
      if (!value.startsWith('--')) return acc.siteId === null ? { ...acc, siteId: value } : acc;

      const name = value.slice(2);
      if (name === 'dry') return { ...acc, dry: true };
      return { ...acc, [name]: all[index + 1] };
    },
    { siteId: null, dry: false, preset: null, logo: null, 'data-dir': null },
  );
}

function usage(message) {
  process.stderr.write(
    `${message}\n\n` +
      '用法：node scripts/seed-site-rules.js <siteId> [--preset <name>] [--logo <file>] [--data-dir <dir>] [--dry]\n' +
      `可用的 preset：${Object.keys(PRESETS).join('、')}\n`,
  );
  process.exitCode = 1;
}

/** §3.6：logo 是一張 PNG，文字替換換不掉它 —— 所以 preset 順便收這個 */
function uploadLogo(store, siteId, file) {
  const buffer = fs.readFileSync(path.resolve(file));
  const checked = validateResourceUpload(buffer, null);

  if (!checked.ok) {
    throw new Error(checked.errors.map((error) => error.message).join('；'));
  }

  const asset = store.assets.put({
    url: `lm://site/${siteId}${TEMPLATEMO_LOGO_PATH}`,
    content: checked.value.content,
    content_type: checked.value.content_type,
  });

  return store.resourceOverrides.put(siteId, {
    path: TEMPLATEMO_LOGO_PATH,
    sha256: asset.sha256,
    content_type: checked.value.content_type,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const presetName = args.preset ?? args.siteId;

  if (!args.siteId) return usage('要給 siteId');
  if (!PRESETS[presetName]) return usage(`沒有這個 preset：${presetName}`);

  const config = loadConfig(
    args['data-dir'] ? { ...process.env, LOCALMONKEY_DATA_DIR: args['data-dir'] } : process.env,
  );

  const store = createStore(openDatabase(config.databaseFile));

  if (!store.sites.get(args.siteId)) {
    return usage(`DB 裡沒有這個站：${args.siteId}（${config.databaseFile}）`);
  }

  const rules = PRESETS[presetName];

  // 先把 preset 自己編一遍：有壞規則就不要寫進去（不然使用者會配出一排紅字）
  const broken = compileRules(rules).filter((rule) => rule.error);
  if (broken.length > 0) {
    return usage(`preset 自己有編不過的規則：\n${broken.map((rule) => `  ${rule.pattern} → ${rule.error}`).join('\n')}`);
  }

  if (args.dry) {
    process.stdout.write(
      `[dry] ${presetName} 有 ${rules.length} 條規則，會配到 ${args.siteId}（${config.databaseFile}）\n` +
        rules.map((rule) => `  ${rule.kind.padEnd(13)} ${rule.pattern}`).join('\n') +
        '\n',
    );
    return undefined;
  }

  const applied = applyPreset(store, args.siteId, rules);
  process.stdout.write(
    `${args.siteId}：新增 ${applied.created} 條、更新 ${applied.updated} 條（共 ${store.siteRules.listBySite(args.siteId).length} 條）\n`,
  );

  if (args.logo) {
    const resource = uploadLogo(store, args.siteId, args.logo);
    process.stdout.write(`logo 覆寫：${resource.path} ← ${args.logo}（${resource.content_type}）\n`);
  } else {
    process.stdout.write(
      `提醒：§3.6 的 logo 是一張 PNG，文字替換換不掉它。要換就加 --logo <檔案>\n` +
        `（或在控制台的「資源覆寫」裡上傳，上游路徑是 ${TEMPLATEMO_LOGO_PATH}）\n`,
    );
  }

  return undefined;
}

main();
