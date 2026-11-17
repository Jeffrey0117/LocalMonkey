'use strict';

const path = require('node:path');
const express = require('express');

const { createAdminAuth, sendUnauthorized, ADMIN_COOKIE_NAME } = require('../middleware/admin-auth.js');
const { tokensMatch } = require('../admin/compare.js');
const { createAdminApiRouter } = require('./admin-api.js');
const { renderErrorPage } = require('../views/pages.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * `GET /admin?token=<t>`：驗過就把 token 放進 cookie，然後 302 到乾淨的 /admin，
 * 這樣網址列（與瀏覽紀錄、分享出去的截圖）就不會留著 token。
 */
function createTokenLogin(adminToken) {
  return function tokenLogin(req, res, next) {
    const { token } = req.query;
    if (typeof token !== 'string') {
      next();
      return;
    }

    if (!tokensMatch(token, adminToken)) {
      sendUnauthorized(req, res);
      return;
    }

    res.setHeader(
      'set-cookie',
      [
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/admin',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      ].join('; '),
    );
    res.redirect(302, '/admin');
  };
}

/**
 * `/admin` 底下的一切：單頁 UI、靜態檔、REST API。全部都要 token。
 */
function createAdminRouter({ store, config, adminToken, logger, fetchImpl, translation }) {
  const router = express.Router();

  router.get('/', createTokenLogin(adminToken));
  router.use(createAdminAuth({ adminToken }));

  router.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.use('/api', createAdminApiRouter({ store, config, logger, fetchImpl, translation }));

  router.use(
    express.static(PUBLIC_DIR, {
      index: false,
      dotfiles: 'deny',
      redirect: false,
    }),
  );

  router.use((req, res) => {
    res
      .status(404)
      .type('html')
      .send(
        renderErrorPage({
          status: 404,
          title: '後台沒有這個頁面',
          paragraphs: ['回到 <code>/admin</code> 吧。'],
        }),
      );
  });

  return router;
}

module.exports = { createAdminRouter, PUBLIC_DIR };
