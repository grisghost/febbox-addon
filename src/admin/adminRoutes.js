'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { registry } = require('./registry');
const tokenPool = require('../providers/febbox/tokenPool');
const { decodeConfigToken, encodeConfigToken, hashToken, MAX_TOKENS } = require('../config/configToken');
const { normalizeToken, isPlausibleToken } = require('../providers/febbox/auth');
const { createRateLimiter } = require('../security/rateLimit');
const metrics = require('../metrics/metrics');
const logger = require('../logging/logger');

/**
 * Admin area: a React page (web/src/Admin.jsx, served at /admin) backed by a
 * JSON API under /api/admin, protected by a password login with a signed,
 * HttpOnly, SameSite=Strict session cookie.
 *
 *   ADMIN_PASSWORD  enables the admin area. Unset => login and every admin
 *                   API answer 404 (the page itself says "not enabled").
 *
 * Sessions are stateless (expiry + HMAC). The HMAC key is derived from
 * CONFIG_SECRET and ADMIN_PASSWORD, so changing either signs everyone out.
 * Serve over HTTPS: the cookie is marked Secure whenever the request is HTTPS.
 */

const COOKIE_NAME = 'fb_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const startedAt = Date.now();
const sha = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function adminEnabled() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function sessionKey() {
  return sha(`admin-session:${process.env.CONFIG_SECRET}:${process.env.ADMIN_PASSWORD}`);
}

function sign(expires) {
  return crypto.createHmac('sha256', sessionKey()).update(String(expires)).digest('hex');
}

function createSessionValue(now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  return `${expires}.${sign(expires)}`;
}

function verifySessionValue(value, now = Date.now()) {
  if (!adminEnabled() || typeof value !== 'string') return false;
  const [expires, mac] = value.split('.');
  if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  const expected = sign(expires);
  if (mac.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isAuthenticated(req) {
  return verifySessionValue(readCookie(req, COOKIE_NAME));
}

function setSessionCookie(req, res, value, maxAgeMs) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Guards every admin API route except session/login/logout. */
function requireSession(req, res, next) {
  if (!adminEnabled()) return res.status(404).json({ error: 'Admin is not enabled' });
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not signed in' });
  res.setHeader('Cache-Control', 'no-store');
  return next();
}

/** Mutating routes need a custom header (a cross-site form can't send it) and a same-origin Origin if present. */
function requireSameOriginAction(req, res, next) {
  if (req.get('X-Admin-Request') !== '1') return res.status(400).json({ error: 'Missing X-Admin-Request header' });
  const origin = req.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request refused' });
    } catch (_) {
      return res.status(403).json({ error: 'Bad Origin' });
    }
  }
  return next();
}

const hash8 = (t) => hashToken(t).slice(0, 8);

/** Tokens an install uses right now: the admin's override, else the ones in its URL. */
function currentTokens(id) {
  const override = registry.getOverrideTokens(id);
  if (override) return override;
  return originalTokens(id);
}

/** Tokens baked into the install URL (null if unknown / undecodable). */
function originalTokens(id) {
  const ct = registry.getConfigToken(id);
  if (!ct) return null;
  try {
    return decodeConfigToken(ct).febboxTokens;
  } catch (_) {
    return null;
  }
}

async function refreshInstall(id) {
  const tokens = currentTokens(id);
  if (!tokens) return null;
  const snaps = await tokenPool.inspectTokens(tokens);
  registry.setTokenSnapshots(id, snaps);
  return snaps;
}

function createAdminRouter() {
  const router = express.Router();
  const apiLimiter = createRateLimiter({ windowMs: 60000, max: 120 });
  // Brute-force guard for the password: 10 attempts per 10 minutes per IP.
  const loginLimiter = createRateLimiter({ windowMs: 10 * 60000, max: 10 });
  const indexFile = path.join(__dirname, '..', '..', 'views', 'public', 'index.html');

  // --- The page itself (same React app as the config page) -----------------
  router.get(['/admin', '/admin/*'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(indexFile, (err) => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('Admin UI is not built. Run "npm run build".');
    });
  });

  // --- Session endpoints (no session required) -----------------------------
  router.get('/api/admin/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: adminEnabled(), authenticated: isAuthenticated(req) });
  });

  router.post('/api/admin/login', loginLimiter, requireSameOriginAction, (req, res) => {
    if (!adminEnabled()) return res.status(404).json({ error: 'Admin is not enabled' });
    const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!supplied || !safeEqual(supplied, process.env.ADMIN_PASSWORD)) {
      logger.warn('admin_login_failed', { ip: req.ip });
      return res.status(401).json({ error: 'Incorrect password' });
    }
    setSessionCookie(req, res, createSessionValue(), SESSION_TTL_MS);
    return res.json({ ok: true });
  });

  router.post('/api/admin/logout', requireSameOriginAction, (req, res) => {
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // --- Everything below needs a valid session ------------------------------
  router.use('/api/admin', apiLimiter, requireSession);

  router.get('/api/admin/overview', (req, res) => {
    const cooldowns = tokenPool.cooldownByShortHash();
    const installs = registry.list().map((rec) => ({
      ...rec,
      // Path of this install's addon URL (the page prepends its own origin).
      // Admin-only: it is as sensitive as the addon link itself.
      installPath: registry.getConfigToken(rec.id) ? `/${registry.getConfigToken(rec.id)}/manifest.json` : null,
      tokens: rec.tokens.map((t) => {
        const cd = cooldowns[t.hash];
        return cd ? { ...t, status: t.status === 'invalid' ? 'invalid' : 'cooldown', cooldown: cd } : t;
      }),
    }));
    res.json({
      now: Date.now(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      totals: registry.totals(),
      metrics: metrics.snapshot(),
      installs,
    });
  });

  router.post('/api/admin/installs/:id/refresh', requireSameOriginAction, async (req, res) => {
    try {
      const snaps = await refreshInstall(req.params.id);
      if (!snaps) return res.status(404).json({ error: 'Install not found or cannot be refreshed' });
      return res.json({ ok: true, tokens: snaps });
    } catch (err) {
      logger.error('admin_refresh_failed', { message: String(err && err.message) });
      return res.status(502).json({ error: 'Refresh failed' });
    }
  });

  router.post('/api/admin/refresh-all', requireSameOriginAction, async (req, res) => {
    const ids = registry.list().map((r) => r.id).slice(0, 50);
    let refreshed = 0;
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await refreshInstall(id)) refreshed += 1;
      } catch (_) {
        /* keep going */
      }
    }
    res.json({ ok: true, refreshed, total: ids.length });
  });

  /**
   * Replace the tokens an install uses without changing its URL.
   * Body: { slots: [ { keep: "<8-char hash>" } | { token: "<new token>" } ] }
   * Existing tokens are referenced by hash so raw tokens never travel to the browser.
   */
  router.put('/api/admin/installs/:id/tokens', requireSameOriginAction, async (req, res) => {
    const { id } = req.params;
    const current = currentTokens(id);
    if (!current) return res.status(404).json({ error: 'Install not found' });

    const slots = Array.isArray(req.body && req.body.slots) ? req.body.slots : [];
    if (slots.length === 0) return res.status(400).json({ error: 'At least one token is required.' });
    if (slots.length > MAX_TOKENS) return res.status(400).json({ error: `At most ${MAX_TOKENS} tokens are supported.` });

    const byHash = new Map(current.map((t) => [hash8(t), t]));
    const tokens = [];
    const fresh = []; // [{ token, position }]
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] || {};
      let token = null;
      if (typeof slot.keep === 'string') {
        token = byHash.get(slot.keep);
        if (!token) return res.status(400).json({ error: `Token #${i + 1} no longer exists; reload and try again.` });
      } else if (typeof slot.token === 'string') {
        token = normalizeToken(slot.token);
        if (!isPlausibleToken(token)) return res.status(400).json({ error: `Token #${i + 1} has an invalid format.` });
        if (!current.includes(token)) fresh.push({ token, position: i + 1 });
      } else {
        return res.status(400).json({ error: `Token #${i + 1} is empty.` });
      }
      if (tokens.includes(token)) return res.status(400).json({ error: `Token #${i + 1} is a duplicate.` });
      tokens.push(token);
    }

    // Reject tokens FebBox says are invalid. A failed lookup (network) is not a rejection.
    for (const { token, position } of fresh) {
      // eslint-disable-next-line no-await-in-loop
      const { status } = await tokenPool.checkQuota(token, { force: true });
      if (status === 'invalid') return res.status(400).json({ error: `Token #${position} was rejected by FebBox.` });
    }

    try {
      registry.setOverride(id, encodeConfigToken({ febboxTokens: tokens }), tokens.map(hash8));
      const snaps = await tokenPool.inspectTokens(tokens);
      registry.setTokenSnapshots(id, snaps);
      logger.info('admin_tokens_updated', { installId: id, count: tokens.length });
      return res.json({ ok: true, tokens: snaps });
    } catch (err) {
      logger.error('admin_tokens_update_failed', { message: String(err && err.message) });
      return res.status(500).json({ error: 'Could not save tokens.' });
    }
  });

  /** Drop the override: the install goes back to the tokens baked into its URL. */
  router.delete('/api/admin/installs/:id/tokens', requireSameOriginAction, (req, res) => {
    const original = originalTokens(req.params.id);
    if (!original) return res.status(404).json({ error: 'Install not found' });
    registry.clearOverride(req.params.id, original.map(hash8));
    return res.json({ ok: true });
  });

  router.post('/api/admin/installs/:id/block', requireSameOriginAction, (req, res) => {
    const blocked = Boolean(req.body && req.body.blocked);
    if (!registry.setBlocked(req.params.id, blocked)) return res.status(404).json({ error: 'Install not found' });
    return res.json({ ok: true, blocked });
  });

  router.delete('/api/admin/installs/:id', requireSameOriginAction, (req, res) => {
    if (!registry.remove(req.params.id)) return res.status(404).json({ error: 'Install not found' });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRouter, createSessionValue, verifySessionValue };
