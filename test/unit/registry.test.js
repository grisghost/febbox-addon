'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { InstallRegistry } = require('../../src/admin/registry');

describe('InstallRegistry', () => {
  test('records installs, counters and token usage', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'manifest', label: 'TV', tokenHashes: ['aaaaaaaa', 'bbbbbbbb'], configToken: 'CT' });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa', 'bbbbbbbb'] });
    r.recordTokenUse('inst1', 'aaaaaaaa');
    r.recordFailover('inst1', 'aaaaaaaa', 'QUOTA_EXCEEDED');
    r.recordResult('inst1', { outcome: 'ok' });
    r.recordResult('inst1', { outcome: 'empty' });
    r.recordResult('inst1', { outcome: 'error', errorCode: 'UPSTREAM_ERROR' });

    const [rec] = r.list();
    expect(rec.label).toBe('TV');
    expect(rec.manifestHits).toBe(1);
    expect(rec.streamRequests).toBe(1);
    expect(rec.streamsServed).toBe(1);
    expect(rec.emptyResponses).toBe(1);
    expect(rec.errors.UPSTREAM_ERROR).toBe(1);
    expect(rec.failovers).toBe(1);
    expect(rec.tokens[0].uses).toBe(1);
    expect(rec.tokens[0].lastFailure.code).toBe('QUOTA_EXCEEDED');
    expect(rec.activity).toBe('active');
  });

  test('list() never exposes the stored encrypted config token', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'], configToken: 'SECRET-CT' });
    expect(JSON.stringify(r.list())).not.toContain('SECRET-CT');
    expect(r.getConfigToken('inst1')).toBe('SECRET-CT');
  });

  test('keeps per-token history when the install is seen again', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'] });
    r.recordTokenUse('inst1', 'aaaaaaaa');
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'] });
    expect(r.list()[0].tokens[0].uses).toBe(1);
  });

  test('block / unblock / remove', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'] });
    expect(r.isBlocked('inst1')).toBe(false);
    expect(r.setBlocked('inst1', true)).toBe(true);
    expect(r.isBlocked('inst1')).toBe(true);
    expect(r.list()[0].activity).toBe('blocked');
    expect(r.setBlocked('nope', true)).toBe(false);
    expect(r.remove('inst1')).toBe(true);
    expect(r.list()).toHaveLength(0);
  });

  test('totals count installs, activity and token problems', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'a', kind: 'stream', tokenHashes: ['h1', 'h2'] });
    r.touch({ id: 'b', kind: 'stream', tokenHashes: ['h3'] });
    r.setTokenSnapshots('a', [{ hash: 'h1', status: 'exhausted', remainingMB: 0, limitMB: 100, isVip: false, checkedAt: 1 }]);
    r.setBlocked('b', true);
    const t = r.totals();
    expect(t.installs).toBe(2);
    expect(t.activeLastHour).toBe(1);
    expect(t.blocked).toBe(1);
    expect(t.tokens).toBe(3);
    expect(t.tokensExhausted).toBe(1);
  });

  test('persists to disk and reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const file = path.join(dir, 'registry.json');
    const r = new InstallRegistry({ filePath: file });
    r.touch({ id: 'inst1', kind: 'stream', label: 'Phone', tokenHashes: ['aaaaaaaa'] });
    r.flush();
    const again = new InstallRegistry({ filePath: file });
    expect(again.list()[0].label).toBe('Phone');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('InstallRegistry token overrides', () => {
  const { encodeConfigToken } = require('../../src/config/configToken');
  process.env.CONFIG_SECRET = process.env.CONFIG_SECRET || 'test-secret-at-least-16-chars';

  test('override replaces the visible token list and is never exposed by list()', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'] });
    r.recordTokenUse('inst1', 'aaaaaaaa');
    const blob = encodeConfigToken({ febboxTokens: ['new-token-111', 'new-token-222'] });
    r.setOverride('inst1', blob, ['aaaaaaaa', 'bbbbbbbb']);

    expect(r.getOverrideTokens('inst1')).toEqual(['new-token-111', 'new-token-222']);
    const rec = r.list()[0];
    expect(rec.hasOverride).toBe(true);
    expect(rec.tokens.map((t) => t.hash)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(rec.tokens[0].uses).toBe(1); // history kept for a token that stayed
    expect(JSON.stringify(rec)).not.toContain(blob);
  });

  test('clearOverride goes back to the original tokens', () => {
    const r = new InstallRegistry({ filePath: null });
    r.touch({ id: 'inst1', kind: 'stream', tokenHashes: ['aaaaaaaa'] });
    r.setOverride('inst1', encodeConfigToken({ febboxTokens: ['new-token-111'] }), ['cccccccc']);
    r.clearOverride('inst1', ['aaaaaaaa']);
    expect(r.getOverrideTokens('inst1')).toBeNull();
    expect(r.list()[0].hasOverride).toBe(false);
    expect(r.list()[0].tokens.map((t) => t.hash)).toEqual(['aaaaaaaa']);
  });
});
