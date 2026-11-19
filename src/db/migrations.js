'use strict';

/**
 * 單向 schema 版本（PRAGMA user_version）。往後要改 schema 就在陣列尾端加一筆，
 * 不改既有的 migration —— 已經跑過的機器只會跑新增的那幾筆。
 *
 * 也因為「不改舊的」，這個檔案裡的 SQL 與常數刻意**不 import** 任何會演化的模組：
 * migration 是凍結的歷史，不該跟著 src/db/*.js 的重構一起變。
 */

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  match_glob  TEXT NOT NULL DEFAULT '*',
  run_at      TEXT NOT NULL DEFAULT 'body-end' CHECK (run_at IN ('head-end', 'body-end')),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scripts_site_order
  ON scripts (site_id, order_index, created_at);
`;

/**
 * v2：腳本不再綁單一站台。
 *
 * v1 的 `scripts.site_id` 是單一外鍵 → 一支腳本配兩個網域就得複製兩份程式碼，
 * 「改一次全部生效」這個核心賣點直接破功。所以改成多對多（script_sites）。
 *
 * `run_at` 的 CHECK 同時留著 v1 的 `head-end` / `body-end`：
 * 舊資料會被這次 migration 轉成 document-*，但 v1 的建立 API（legacy 相容層）
 * 還是會寫入那兩個值，而且它們的注入位置與 v1 完全一樣（見 lib/injection.js）。
 */
const SCHEMA_V2_STRUCTURE = `
ALTER TABLE sites ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0 CHECK (auto_created IN (0, 1));
ALTER TABLE sites ADD COLUMN from_pattern TEXT;

ALTER TABLE scripts RENAME TO scripts_v1;
DROP INDEX IF EXISTS idx_scripts_site_order;

CREATE TABLE scripts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT,
  description TEXT,
  source      TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  run_at      TEXT NOT NULL DEFAULT 'document-end'
                CHECK (run_at IN ('document-start', 'document-end', 'document-idle', 'head-end', 'body-end')),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE script_sites (
  script_id    TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  site_id      TEXT NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
  path_glob    TEXT NOT NULL,
  exclude_glob TEXT,
  PRIMARY KEY (script_id, site_id, path_glob)
);

CREATE TABLE assets (
  sha256       TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  content      BLOB NOT NULL,
  content_type TEXT,
  bytes        INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE INDEX idx_scripts_order      ON scripts (order_index, created_at, id);
CREATE INDEX idx_script_sites_site  ON script_sites (site_id);
CREATE INDEX idx_assets_url         ON assets (url);
`;

/** v1 的腳本沒有 header 可解析，先標成 legacy；使用者下次存檔才會真的解析一遍。 */
const LEGACY_METADATA_JSON = JSON.stringify({
  legacy: true,
  hasMetadataBlock: false,
  needsShim: false,
  grants: [],
  canonicalGrants: [],
  supportedGrants: [],
  unsupportedGrants: [],
  connect: [],
  connectAll: false,
  requires: [],
  resources: [],
  requireAssets: [],
  resourceAssets: [],
  noframes: false,
  targets: [],
  excludes: [],
  notices: [],
});

const COPY_SCRIPTS_V1 = `
INSERT INTO scripts
  (id, name, version, description, source, metadata, run_at, enabled, order_index, created_at, updated_at)
SELECT
  id,
  name,
  NULL,
  NULL,
  code,
  @metadata,
  CASE run_at
    WHEN 'head-end' THEN 'document-start'
    WHEN 'body-end' THEN 'document-end'
    ELSE 'document-end'
  END,
  enabled,
  order_index,
  created_at,
  updated_at
FROM scripts_v1
`;

/**
 * `WHERE site_id IN (…)` 是給「資料庫被手動改過、留下孤兒腳本」的機器用的：
 * 孤兒的程式碼照樣搬進新表（不刪使用者的東西），只是沒有綁定。
 */
const COPY_BINDINGS_V1 = `
INSERT INTO script_sites (script_id, site_id, path_glob, exclude_glob)
SELECT id, site_id, match_glob, NULL
FROM scripts_v1
WHERE site_id IN (SELECT id FROM sites)
`;

function upgradeToV2(db) {
  db.exec(SCHEMA_V2_STRUCTURE);
  db.prepare(COPY_SCRIPTS_V1).run({ metadata: LEGACY_METADATA_JSON });
  db.prepare(COPY_BINDINGS_V1).run();
  db.exec('DROP TABLE scripts_v1;');
}

/**
 * v3：投遞模式（SPEC-console §8）。
 *
 * 每支腳本一組不可猜的 token，`GET /s/<token>/<slug>.user.js` 靠它當憑證 ——
 * Tampermonkey 抓腳本時帶不了 admin token，所以那個端點必須免認證。
 *
 * UNIQUE 索引在 SQLite 容許多個 NULL，所以先加欄位再回填既有資料。
 */
const SCHEMA_V3 = `
ALTER TABLE scripts ADD COLUMN delivery_token TEXT;
CREATE UNIQUE INDEX idx_scripts_delivery_token ON scripts (delivery_token);
`;

function upgradeToV3(db) {
  db.exec(SCHEMA_V3);

  const rows = db.prepare('SELECT id FROM scripts').all();
  const update = db.prepare('UPDATE scripts SET delivery_token = ? WHERE id = ?');

  for (const row of rows) {
    update.run(require('node:crypto').randomBytes(32).toString('hex'), row.id);
  }
}

/**
 * v4：伺服器端翻譯層（SPEC-translate §2）。
 *
 * `translations` 是整個設計的主幹而不是優化 —— 靜態內容不常變，所以
 * 翻一次就永久有效。`hash` 含 model，**換模型會自動重翻**，舊的留著不刪
 * （可以比較、可以回退）。
 *
 * `translate_queue.site_id` **刻意不是外鍵**：那個欄位只為了 UI 分組
 * （「哪個站先遇到這段」），刪掉一個網站不該連帶砍掉待翻的段 ——
 * 而且 `INSERT OR IGNORE` 會把外鍵違規一起吞掉（地雷 15），
 * 沒有外鍵的話那個 IGNORE 就只可能是「PK 撞到」，語意乾淨。
 */
const SCHEMA_V4 = `
CREATE TABLE translations (
  hash        TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  model       TEXT NOT NULL,
  translated  TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('machine', 'manual')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE translate_queue (
  hash        TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  model       TEXT NOT NULL,
  site_id     TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE crawl_jobs (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  status       TEXT NOT NULL
                 CHECK (status IN ('running', 'paused', 'done', 'failed', 'cancelled')),
  start_path   TEXT NOT NULL,
  max_pages    INTEGER NOT NULL,
  max_depth    INTEGER NOT NULL,
  pages_done   INTEGER NOT NULL DEFAULT 0,
  pages_found  INTEGER NOT NULL DEFAULT 0,
  segments_new INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

ALTER TABLE sites ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (translate_enabled IN (0, 1));
ALTER TABLE sites ADD COLUMN translate_lang TEXT NOT NULL DEFAULT 'zh-TW';
ALTER TABLE sites ADD COLUMN translate_model TEXT;
ALTER TABLE sites ADD COLUMN glossary TEXT;

CREATE INDEX idx_translations_lookup  ON translations (target_lang, source_text);
CREATE INDEX idx_translations_updated ON translations (updated_at DESC, hash);
CREATE INDEX idx_queue_attempts       ON translate_queue (attempts, created_at);
CREATE INDEX idx_crawl_jobs_site      ON crawl_jobs (site_id, created_at DESC);
`;

/**
 * v5：使用者自訂的站台改造規則（SPEC-rules §2 / §3.6）。
 *
 * `site_rules.scope` 不在規格 §2 的欄位表裡 —— 它是 §3.2 自己追加的
 * （卡片標題那條規則全站套會把「2026 年的…」一起改掉，所以要能限定範圍）。
 *
 * `resource_overrides.sha256` **是外鍵**，指向內容定址的 `assets`：
 * 覆寫指到一個不存在的檔案的話，使用者看到的是「換了圖但圖破了」，
 * 而那時候已經來不及知道原因。寧可在寫入當下就丟錯。
 *
 * `UNIQUE(site_id, path)`：一個站的一條路徑只會有一種覆寫 ——
 * 「再上傳一張」的語意是換掉，不是長出第二列（見 db/resource-overrides.js）。
 */
const SCHEMA_V5 = `
CREATE TABLE site_rules (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('hide', 'text-replace', 'text-rewrite')),
  pattern     TEXT NOT NULL,
  replacement TEXT,
  scope       TEXT,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE resource_overrides (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL REFERENCES assets(sha256),
  content_type TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (site_id, path)
);

CREATE INDEX idx_site_rules_site ON site_rules (site_id, order_index, id);
CREATE INDEX idx_resource_overrides_site ON resource_overrides (site_id, path);
`;

/**
 * v6：`css` 規則型別（SPEC-rules §9）＋ per-site 開發模式（§8.2）。
 *
 * ⛔ `site_rules.kind` 的 CHECK 是寫在建表語句裡的，SQLite 不能 ALTER 掉它 ——
 * 只能**重建整張表**。順序照地雷 11 的教訓來：先 rename 舊表、建新表、複製、
 * 最後才 DROP。`site_rules` 沒有任何表反過來指著它（它只指向 `sites`），
 * 所以 DROP 不會觸發別人的 CASCADE。
 *
 * 新表的 CHECK 多一個 `'css'`。`hide` 其實是 `css` 的特例（它產生的就是
 * `選擇器 { display: none !important }`），但兩個都留著：`hide` 只要一個選擇器、
 * 不用懂 CSS，而且控制台能幫它數命中幾個元素。
 *
 * `sites.dev_mode` 打開時所有代理回應都 `no-cache`（保留 ETag）。預設關 ——
 * 它是「反覆調規則的時候打開、調完關掉」的開關，不是常駐狀態。
 */
const SCHEMA_V6 = `
ALTER TABLE site_rules RENAME TO site_rules_v5;

CREATE TABLE site_rules (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('hide', 'css', 'text-replace', 'text-rewrite')),
  pattern     TEXT NOT NULL,
  replacement TEXT,
  scope       TEXT,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO site_rules
  (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
SELECT
  id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at
FROM site_rules_v5;

DROP TABLE site_rules_v5;

CREATE INDEX idx_site_rules_site ON site_rules (site_id, order_index, id);

ALTER TABLE sites ADD COLUMN dev_mode INTEGER NOT NULL DEFAULT 0
  CHECK (dev_mode IN (0, 1));
`;

/**
 * v7：`no-translate` 規則型別（SPEC-rules §12）。
 *
 * 又一次重建 `site_rules` —— 同 v6 的理由（`kind` 的 CHECK 在建表語句裡）、
 * 同樣的順序（rename → 建新表 → 複製 → DROP → 重建 index）。
 * **這一版只動 CHECK，欄位一個都沒變**，所以複製是整列照搬；真正的風險還是
 * 「既有規則在重建的過程中掉了」—— 那是靜默的，使用者的站會突然變回沒改造過的樣子。
 *
 * `no-translate` 的 pattern 是**文字比對**不是選擇器（理由在
 * `rules/no-translate.js`：伺服器端沒有 DOM，而那段樣板文跟要翻的段同一個容器）。
 */
const SCHEMA_V7 = `
ALTER TABLE site_rules RENAME TO site_rules_v6;

CREATE TABLE site_rules (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('hide', 'css', 'text-replace', 'text-rewrite', 'no-translate')),
  pattern     TEXT NOT NULL,
  replacement TEXT,
  scope       TEXT,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO site_rules
  (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
SELECT
  id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at
FROM site_rules_v6;

DROP TABLE site_rules_v6;

CREATE INDEX idx_site_rules_site ON site_rules (site_id, order_index, id);
`;

/**
 * v8：重繪模式（SPEC-reskin）。
 *
 * ⛔ **這一版不碰 `site_rules`。** v6 與 v7 各重建了一整張 `site_rules`，那是
 * 因為它們加了新的 `kind`，而 `CHECK` 不能 ALTER（地雷 58）。重繪**不是**一種
 * 規則 —— 它是第三種模式，設定掛在 `sites` 上。所以這一版只有
 * `ADD COLUMN` 與 `CREATE TABLE`，整張表重建的風險（「既有規則在搬家時掉了」）
 * 一個都沒有。
 *
 * 四個欄位：
 *   - `reskin_enabled`  預設關（規格 §6：「開關（預設關）」）
 *   - `reskin_theme`    NULL ＝ 用預設版型，語意同 `translate_model`
 *   - `reskin_config`   抽取設定（JSON 陣列）。**編不過也要存得起來** ——
 *                       跟壞規則一樣（SPEC-rules §4），退回 400 的話使用者
 *                       只看到一個錯誤、沒有上下文可以改。所以沒有 CHECK。
 *   - `reskin_pricing`  價格方案（JSON 物件）。NULL ＝ 用 `pricing.js` 的預設
 *
 * `reskin_cache` 的 key 含**上游 HTML 的 sha256**（規格 §3.3），所以上游一變
 * 就自然錯開，不需要任何失效邏輯。`site_id` 給 ON DELETE CASCADE ——
 * 快取是純衍生資料，刪站連帶清掉完全沒有損失（這跟 `translate_queue` 刻意
 * 不設外鍵是相反的判斷：那裡的佇列是「還沒做完的工作」，不是衍生資料）。
 */
const SCHEMA_V8 = `
ALTER TABLE sites ADD COLUMN reskin_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (reskin_enabled IN (0, 1));
ALTER TABLE sites ADD COLUMN reskin_theme TEXT;
ALTER TABLE sites ADD COLUMN reskin_config TEXT;
ALTER TABLE sites ADD COLUMN reskin_pricing TEXT;

CREATE TABLE reskin_cache (
  key         TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  kind        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_reskin_cache_site ON reskin_cache (site_id, created_at);
`;

/**
 * v9：單筆買斷的訂單（SPEC-checkout §3）。
 *
 * ⛔ **`site_id` 刻意沒有外鍵。** `reskin_cache`（v8）是 `ON DELETE CASCADE`，
 * 因為它是純衍生資料；訂單相反 —— 刪一個站不該把那個站收過的錢一起刪掉。
 * 這跟 `translate_queue.site_id` 不設外鍵是同一個判斷，代價是可能留下孤兒
 * 訂單，而那比「靜默刪掉金流紀錄」好得多。
 *
 * ⛔ `status` 與 `env` 都有 CHECK。`env` 記的是「這筆是在哪個環境建的」——
 * 測試單與正式單混在一起對帳會對出一個假的數字，而那是沒辦法事後補救的。
 *
 * ⛔ `raw_result` 存的是**解密後**的回應（對帳依據）。金鑰不在裡面，
 * 也不准被寫進去。
 */
const SCHEMA_V9 = `
CREATE TABLE reskin_orders (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  product_name TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'TWD',
  status       TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  env          TEXT NOT NULL CHECK (env IN ('test', 'live')),
  trade_no     TEXT,
  paid_at      TEXT,
  created_at   TEXT NOT NULL,
  raw_result   TEXT
);

CREATE INDEX idx_reskin_orders_site ON reskin_orders (site_id, created_at);
`;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    up: (db) => db.exec(SCHEMA_V1),
  }),
  Object.freeze({
    version: 2,
    up: upgradeToV2,
  }),
  Object.freeze({
    version: 3,
    up: upgradeToV3,
  }),
  Object.freeze({
    version: 4,
    up: (db) => db.exec(SCHEMA_V4),
  }),
  Object.freeze({
    version: 5,
    up: (db) => db.exec(SCHEMA_V5),
  }),
  Object.freeze({
    version: 6,
    up: (db) => db.exec(SCHEMA_V6),
  }),
  Object.freeze({
    version: 7,
    up: (db) => db.exec(SCHEMA_V7),
  }),
  Object.freeze({
    version: 8,
    up: (db) => db.exec(SCHEMA_V8),
  }),
  Object.freeze({
    version: 9,
    up: (db) => db.exec(SCHEMA_V9),
  }),
]);

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      apply();
    } catch (cause) {
      throw new Error(`schema migration v${migration.version} 失敗：${cause.message}`, { cause });
    }
  }

  return db.pragma('user_version', { simple: true });
}

module.exports = { migrate, MIGRATIONS, SCHEMA_VERSION };
