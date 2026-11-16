'use strict';

const { loadConfig } = require('./config.js');
const { createLogger } = require('./logger.js');
const { openDatabase } = require('./db/index.js');
const { createStore } = require('./db/store.js');
const { ensureAdminToken } = require('./admin/token.js');
const { createApp } = require('./app.js');

function logStartupNotes({ logger, config, token }) {
  logger.info(`LocalMonkey 聽在 http://${config.host}:${config.port}`);
  logger.info(`後台：http://${config.host}:${config.port}/admin`);

  if (token.source === 'file') {
    logger.info(`後台 token 來自 ${token.file}（要貼到 /admin?token=... 一次）`);
  }
  if (token.source === 'env') {
    logger.info('後台 token 來自 LOCALMONKEY_ADMIN_TOKEN');
  }

  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    logger.warn(
      `HOST=${config.host}：管理後台現在對整個網段開著。` +
        '擋在前面的只有那把 token，請確認你知道這件事。',
    );
  }
  if (config.allowPrivate) {
    logger.warn('LOCALMONKEY_ALLOW_PRIVATE=1：SSRF 防護已關閉，可以代理內網位址。');
  }
}

function start(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel });

  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  const token = ensureAdminToken({ envToken: config.adminToken, dataDir: config.dataDir, logger });

  const app = createApp({ store, config, adminToken: token.token, logger });
  const server = app.listen(config.port, config.host, () => {
    logStartupNotes({ logger, config, token });
  });

  server.on('error', (error) => {
    logger.error(`無法在 ${config.host}:${config.port} 啟動：${error.message}`);
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    logger.info(`收到 ${signal}，正在關閉…`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, store, db, config, token };
}

if (require.main === module) start();

module.exports = { start };
