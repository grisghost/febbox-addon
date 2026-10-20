'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Install registry: what the admin page shows.
 *
 * Config tokens are stateless (everything lives inside the encrypted install
 * URL), so the server doesn't otherwise know which installs exist. We record
 * each install the first time it's seen (manifest or stream request) under
 * its install id (hash of its token set) and keep usage counters.
 *
 * Privacy rules:
 *  - Raw FebBox tokens are never stored here. Per-token entries are keyed by
 *    the first 8 hex chars of a SHA-256 hash.
 *  - We do store the *encrypted* config token (`ct`) so the admin can refresh
 *    quotas without waiting for traffic. It is useless without CONFIG_SECRET
 *    and is never returned by the admin API.
 *  - The JSON file is written with mode 0600.
 *
 * Persistence is a debounced atomic JSON write. Disabled when filePath is
 * null (tests). On hosts with ephemeral disks (e.g. Render free tier) the
 * registry resets on redeploy — mount a volume at DATA_DIR to keep it.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

class InstallRegistry {
  constructor({ filePath = null, maxEntries = 1000, flushMs = 10000 } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.flushMs = flushMs;
    this.installs = new Map();
    this._timer = null;
    this._dirty = false;
    if (filePath) this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      for (const rec of Array.isArray(data.installs) ? data.installs : []) {
        if (rec && typeof rec.id === 'string') this.installs.set(rec.id, rec);
      }
    } catch (_) {
      /* first run or unreadable file: start empty */
    }
  }

  _markDirty() {
    this._dirty = true;
    if (!this.filePath || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.flushMs);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this.filePath || !this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, installs: [...this.installs.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (_) {
      this._dirty = true; // retry on next change
    }
  }

  _evictIfNeeded() {
    if (this.installs.size < this.maxEntries) return;
    let oldest = null;
    for (const rec of this.installs.values()) {
      if (rec.blocked) continue;
      if (!oldest || rec.lastSeen < oldest.lastSeen) oldest = rec;
    }
    if (oldest) this.installs.delete(oldest.id);
  }

  /**
   * Record that an install was seen. Creates the record if new, and syncs
   * its token list (keeping per-token history for hashes already known).
   * @param {{id:string, tokenHashes:string[], label?:string, playbackMode?:string, displayMode?:string, configToken?:string, kind:'manifest'|'stream'}} info
   */
  touch(info) {
    const now = Date.now();
    let rec = this.installs.get(info.id);
    if (!rec) {
      this._evictIfNeeded();
      rec = {
        id: info.id,
        label: '',
        firstSeen: now,
        lastSeen: now,
        manifestHits: 0,
        streamRequests: 0,
        streamsServed: 0,
        emptyResponses: 0,
        errors: {},
        lastError: null,
        failovers: 0,
        blocked: false,
        tokens: [],
      };
      this.installs.set(info.id, rec);
    }
    rec.lastSeen = now;
    if (info.kind === 'manifest') rec.manifestHits += 1;
    if (info.kind === 'stream') rec.streamRequests += 1;
    if (typeof info.label === 'string') rec.label = info.label;
    if (info.playbackMode) rec.playbackMode = info.playbackMode;
    if (info.displayMode) rec.displayMode = info.displayMode;
    if (info.configToken) rec.ct = info.configToken;

    const known = new Map((rec.tokens || []).map((t) => [t.hash, t]));
    rec.tokens = info.tokenHashes.map(
      (hash) => known.get(hash) || { hash, status: 'unknown', uses: 0, lastUsed: null, lastFailure: null }
    );
    this._markDirty();
    return rec;
  }

  /** @param {'ok'|'empty'|'error'} outcome */
  recordResult(id, { outcome, streams = 0, errorCode = null }) {
    const rec = this.installs.get(id);
    if (!rec) return;
    if (outcome === 'ok') rec.streamsServed += 1;
    else if (outcome === 'empty') rec.emptyResponses += 1;
    else if (outcome === 'error') {
      const code = errorCode || 'UNEXPECTED';
      rec.errors[code] = (rec.errors[code] || 0) + 1;
      rec.lastError = { code, at: Date.now() };
    }
    this._markDirty();
  }

  recordTokenUse(id, hash) {
    const t = this._token(id, hash);
    if (!t) return;
    t.uses = (t.uses || 0) + 1;
    t.lastUsed = Date.now();
    this._markDirty();
  }

  recordFailover(id, hash, code) {
    const rec = this.installs.get(id);
    const t = this._token(id, hash);
    if (!rec || !t) return;
    rec.failovers += 1;
    t.lastFailure = { code, at: Date.now() };
    this._markDirty();
  }

  /** Merge fresh per-token snapshots (from tokenPool.inspectTokens). */
  setTokenSnapshots(id, snapshots) {
    const rec = this.installs.get(id);
    if (!rec) return;
    for (const snap of snapshots) {
      const t = rec.tokens.find((x) => x.hash === snap.hash);
      if (!t) continue;
      t.status = snap.status;
      t.remainingMB = snap.remainingMB;
      t.limitMB = snap.limitMB;
      t.isVip = snap.isVip;
      t.checkedAt = snap.checkedAt;
    }
    this._markDirty();
  }

  _token(id, hash) {
    const rec = this.installs.get(id);
    return rec && rec.tokens.find((t) => t.hash === hash);
  }

  isBlocked(id) {
    const rec = this.installs.get(id);
    return Boolean(rec && rec.blocked);
  }

  setBlocked(id, blocked) {
    const rec = this.installs.get(id);
    if (!rec) return false;
    rec.blocked = Boolean(blocked);
    this._markDirty();
    return true;
  }

  remove(id) {
    const ok = this.installs.delete(id);
    if (ok) this._markDirty();
    return ok;
  }

  /** Encrypted config token for an install (admin refresh only; never sent to clients). */
  getConfigToken(id) {
    const rec = this.installs.get(id);
    return rec ? rec.ct || null : null;
  }

  /** Public (admin-safe) view of every install, newest activity first. */
  list(now = Date.now()) {
    return [...this.installs.values()]
      .map((rec) => {
        const { ct, ...safe } = rec; // eslint-disable-line no-unused-vars
        const age = now - rec.lastSeen;
        return {
          ...safe,
          activity: rec.blocked ? 'blocked' : age <= HOUR ? 'active' : age <= DAY ? 'recent' : 'idle',
        };
      })
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  totals(now = Date.now()) {
    const all = [...this.installs.values()];
    const tokens = all.flatMap((r) => r.tokens || []);
    return {
      installs: all.length,
      activeLastHour: all.filter((r) => !r.blocked && now - r.lastSeen <= HOUR).length,
      activeLast24h: all.filter((r) => !r.blocked && now - r.lastSeen <= DAY).length,
      blocked: all.filter((r) => r.blocked).length,
      tokens: tokens.length,
      tokensExhausted: tokens.filter((t) => t.status === 'exhausted' || t.status === 'cooldown').length,
      tokensInvalid: tokens.filter((t) => t.status === 'invalid').length,
    };
  }
}

function createDefaultRegistry() {
  // Jest sets NODE_ENV=test: never write files from unit tests.
  if (process.env.NODE_ENV === 'test') return new InstallRegistry({ filePath: null });
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return new InstallRegistry({ filePath: path.join(dir, 'registry.json') });
}

const registry = createDefaultRegistry();

// Persist pending changes on shutdown (only when persistence is on).
if (registry.filePath) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      registry.flush();
      process.exit(0);
    });
  }
}

module.exports = { InstallRegistry, registry };
