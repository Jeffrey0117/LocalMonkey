'use strict';

const express = require('express');

const { wrapUserCode } = require('../lib/user-script.js');

/**
 * `/__lm/*`：LocalMonkey 自己的端點。只有一個：把腳本當外部 .js 送出去。
 * 刻意不要求後台 token —— 這是瀏覽器匿名載入的資源。
 */
function createInternalRouter({ store }) {
  const router = express.Router();

  router.get('/script/:scriptFile', (req, res) => {
    const { scriptFile } = req.params;
    if (!scriptFile.endsWith('.js')) {
      res.status(404).type('text/plain; charset=utf-8').send('腳本不存在');
      return;
    }

    const script = store.scripts.get(scriptFile.slice(0, -'.js'.length));
    if (!script || !script.enabled) {
      res.status(404).type('text/plain; charset=utf-8').send('腳本不存在或已停用');
      return;
    }

    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache'); // 改完要立刻生效
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(wrapUserCode(script.name, script.code));
  });

  router.use((req, res) => {
    res.status(404).type('text/plain; charset=utf-8').send('LocalMonkey：沒有這個內部端點');
  });

  return router;
}

module.exports = { createInternalRouter };
