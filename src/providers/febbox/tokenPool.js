'use strict';

const { hashToken } = require('../../config/configToken');
const { TtlCache } = require('../../cache/ttlCache');
const { FebBoxError } = require('./types');
const { incrementCounter, METRIC } = require('../../metrics/metrics');
const logger = require('../../logging/logger');

/**
 * Multi-token pool with automatic failover.
 *
 * An install can carry up to MAX_TOKENS FebBox tokens, ordered by priority
 * (first = preferred). For every stream request we pick the first token that
 * still has quota; if FebBox rejects it mid-request (auth / quota / 429) it is
 * put on a cooldown and the next token is tried.
 *
 * Two mechanisms, because FebBox charges quota at *playback* time (the direct
 * link we hand to Stremio is what consumes it), not when we resolve the link:
 *   1. Proactive: before resolving, read each token's remaining quota
 *      (`/console/user_cards`, cached ~2 min) and skip tokens that are
 *      exhausted or below MIN_REMAINING_MB. This is the main mechanism.
 *   2. Reactive: if a resolve call itself fails with AUTH_INVALID /
 *      QUOTA_EXCEEDED / RATE_LIMITED, cool that token down and retry with
 *      the next one.
 *
 * With a single token nothing changes: no extra quota request, no cooldown
 * filtering — behaviour is identical to the pre-pool code.
 *
 * Raw tokens are never logged or used as keys: everything is keyed by
 * hashToken(); only the first 8 hex chars are ever exposed (admin page).
 */

const QUOTA_TTL_MS = 2 * 60 * 1000;
const COOLDOWN_MS = {
  QUOTA_EXCEEDED: 10 * 60 * 1000,
  AUTH_INVALID: 6 * 60 * 60 * 1000,
  RATE_LIMITED: 60 * 1000,
};
const FAILOVER_CODES = new Set(Object.keys(COOLDOWN_MS));

const quotaCache = new TtlCache({ maxEntries: 500 }); // hash -> { limitMB, usageMB, remainingMB, isVip, checkedAt }
const cooldowns = new Map(); // hash -> { code, until }

let quotaFetcher = null; // test seam

function fetchQuota(token) {
  if (quotaFetcher) return quotaFetcher(token);
  // Lazy so this module (and its tests) don't need axios unless actually used.
  return require('./client').getQuota({ token });
}

/** Tests only: replace the quota lookup. Pass null to restore the real one. */
function setQuotaFetcher(fn) {
  quotaFetcher = fn || null;
}

function minRemainingMB() {
  const n = Number(process.env.MIN_REMAINING_MB);
  return Number.isFinite(n) && n >= 0 ? n : 1024;
}

const shortHash = (token) => hashToken(token).slice(0, 8);
const fullHash = (token) => hashToken(token);

function getCooldown(hash, now = Date.now()) {
  const c = cooldowns.get(hash);
  if (!c) return null;
  if (c.until <= now) {
    cooldowns.delete(hash);
    return null;
  }
  return c;
}

/** Is this token (by full hash) currently cooling down? */
function isCooling(hash) {
  return Boolean(getCooldown(hash));
}

function markBad(token, code, now = Date.now()) {
  const ms = COOLDOWN_MS[code];
  if (!ms) return;
  cooldowns.set(fullHash(token), { code, until: now + ms });
  quotaCache.del(fullHash(token));
}

/** Map a quota object to a status. limit<=0 means "can't tell" -> unknown, never exhausted. */
function classify(q) {
  if (!q || !(q.limitMB > 0)) return 'unknown';
  if (q.remainingMB <= 0) return 'exhausted';
  if (q.remainingMB < minRemainingMB()) return 'low';
  return 'ok';
}

/**
 * @returns {Promise<{status:'ok'|'low'|'exhausted'|'invalid'|'unknown', quota?:object}>}
 */
async function checkQuota(token, { force = false } = {}) {
  const h = fullHash(token);
  if (!force) {
    const cached = quotaCache.get(h);
    if (cached) return { status: classify(cached), quota: cached };
  }
  try {
    const q = { ...(await fetchQuota(token)), checkedAt: Date.now() };
    quotaCache.set(h, q, QUOTA_TTL_MS);
    return { status: classify(q), quota: q };
  } catch (err) {
    if (err instanceof FebBoxError && err.code === 'AUTH_INVALID') {
      markBad(token, 'AUTH_INVALID');
      return { status: 'invalid' };
    }
    // Network hiccup / 429 / shape change: don't penalize the token, just don't know.
    return { status: 'unknown' };
  }
}

/**
 * Order tokens by who should be tried first. Lazy: quota is checked in
 * priority order only until the first usable token is found; the rest are
 * appended unverified as fallbacks.
 * @returns {Promise<string[]>} tokens to try, best first (may be empty)
 */
async function orderTokens(tokens) {
  const uniq = [...new Set((tokens || []).filter(Boolean))];
  if (uniq.length <= 1) return uniq;

  const usable = [];
  const unverified = [];
  const low = [];
  let found = false;
  for (const token of uniq) {
    if (isCooling(fullHash(token))) continue;
    if (found) {
      unverified.push(token);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { status, quota } = await checkQuota(token);
    if (status === 'ok' || status === 'unknown') {
      usable.push(token);
      found = true;
    } else if (status === 'low') {
      low.push({ token, remaining: quota.remainingMB });
    }
    // 'exhausted' / 'invalid' -> skipped
  }
  low.sort((a, b) => b.remaining - a.remaining);
  return [...usable, ...unverified, ...low.map((l) => l.token)];
}

/**
 * Run `fn(token)` with failover across the pool.
 * @param {string[]} tokens ordered by priority
 * @param {(token:string)=>Promise<any>} fn
 * @param {{onEvent?:(e:object)=>void}} [opts]
 *   events: {type:'used', hash, index} | {type:'failover', hash, code}
 * @returns {Promise<{result:any, token:string, hash:string, index:number}>}
 */
async function withFailover(tokens, fn, { onEvent } = {}) {
  const emit = (e) => {
    try {
      if (onEvent) onEvent(e);
    } catch (_) {
      /* observers must never break playback */
    }
  };
  const candidates = await orderTokens(tokens);
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const token = candidates[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await fn(token);
      emit({ type: 'used', hash: shortHash(token), index: (tokens || []).indexOf(token) });
      return { result, token, hash: fullHash(token), index: (tokens || []).indexOf(token) };
    } catch (err) {
      lastErr = err;
      if (err instanceof FebBoxError && FAILOVER_CODES.has(err.code)) {
        markBad(token, err.code);
        incrementCounter(METRIC.TOKEN_FAILOVER);
        emit({ type: 'failover', hash: shortHash(token), code: err.code });
        logger.warn('token_failover', { tokenId: shortHash(token), code: err.code, remaining: candidates.length - i - 1 });
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new FebBoxError('No FebBox token with available quota', 'QUOTA_EXCEEDED');
}

/**
 * Fresh status for every token of an install (admin page). Forces a new
 * quota lookup. Never returns raw tokens.
 */
async function inspectTokens(tokens) {
  const out = [];
  for (const token of tokens || []) {
    // eslint-disable-next-line no-await-in-loop
    const { status, quota } = await checkQuota(token, { force: true });
    const cd = getCooldown(fullHash(token));
    out.push({
      hash: shortHash(token),
      status: cd && status !== 'invalid' ? 'cooldown' : status,
      cooldown: cd ? { code: cd.code, until: cd.until } : null,
      remainingMB: quota ? quota.remainingMB : null,
      limitMB: quota ? quota.limitMB : null,
      isVip: quota ? Boolean(quota.isVip) : null,
      checkedAt: Date.now(),
    });
  }
  return out;
}

/** Cooldown info by short hash, for the admin overview (no network). */
function cooldownByShortHash() {
  const now = Date.now();
  const out = {};
  for (const [h, c] of cooldowns.entries()) {
    if (c.until > now) out[h.slice(0, 8)] = { code: c.code, until: c.until };
  }
  return out;
}

function reset() {
  quotaCache.clear();
  cooldowns.clear();
  quotaFetcher = null;
}

module.exports = {
  withFailover,
  orderTokens,
  checkQuota,
  inspectTokens,
  cooldownByShortHash,
  isCooling,
  markBad,
  setQuotaFetcher,
  reset,
  FAILOVER_CODES,
};
