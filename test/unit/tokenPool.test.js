'use strict';

process.env.CONFIG_SECRET = 'test-secret-at-least-16-chars';

const pool = require('../../src/providers/febbox/tokenPool');
const { FebBoxError } = require('../../src/providers/febbox/types');
const { hashToken } = require('../../src/config/configToken');

const GB = 1024;
const quota = (remainingGB, limitGB = 100) => ({
  limitMB: limitGB * GB,
  usageMB: (limitGB - remainingGB) * GB,
  remainingMB: remainingGB * GB,
  isVip: false,
});

describe('tokenPool', () => {
  let quotas; // token -> quota object | FebBoxError
  let quotaCalls;

  beforeEach(() => {
    pool.reset();
    delete process.env.MIN_REMAINING_MB;
    quotas = {};
    quotaCalls = 0;
    pool.setQuotaFetcher(async (token) => {
      quotaCalls += 1;
      const q = quotas[token];
      if (q instanceof Error) throw q;
      return q;
    });
  });
  afterAll(() => pool.reset());

  test('single token: no quota lookup, fn runs once with that token', async () => {
    const out = await pool.withFailover(['only-token-1'], async (t) => `ok:${t}`);
    expect(out.result).toBe('ok:only-token-1');
    expect(quotaCalls).toBe(0);
  });

  test('uses the first token when it has quota', async () => {
    quotas = { 'token-aaaa': quota(50), 'token-bbbb': quota(50) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-aaaa');
    expect(out.index).toBe(0);
    expect(quotaCalls).toBe(1); // lazy: second token not even checked
  });

  test('skips a token whose quota is exhausted (proactive)', async () => {
    quotas = { 'token-aaaa': quota(0), 'token-bbbb': quota(40) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-bbbb');
    expect(out.index).toBe(1);
  });

  test('prefers a healthy later token over an earlier one below MIN_REMAINING_MB', async () => {
    process.env.MIN_REMAINING_MB = String(5 * GB);
    quotas = { 'token-aaaa': quota(1), 'token-bbbb': quota(30) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-bbbb');
  });

  test('falls back to a low-quota token when nothing better exists', async () => {
    process.env.MIN_REMAINING_MB = String(5 * GB);
    quotas = { 'token-aaaa': quota(1), 'token-bbbb': quota(2) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-bbbb'); // most remaining among the low ones
  });

  test('skips an invalid token found during the quota check', async () => {
    quotas = { 'token-aaaa': new FebBoxError('nope', 'AUTH_INVALID'), 'token-bbbb': quota(40) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-bbbb');
  });

  test('reactive failover: quota error from fn switches to next token and cools the first down', async () => {
    quotas = { 'token-aaaa': quota(50), 'token-bbbb': quota(50) };
    const events = [];
    const attempts = [];
    const fn = async (t) => {
      attempts.push(t);
      if (t === 'token-aaaa') throw new FebBoxError('over quota', 'QUOTA_EXCEEDED');
      return 'done';
    };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], fn, { onEvent: (e) => events.push(e) });
    expect(out.result).toBe('done');
    expect(attempts).toEqual(['token-aaaa', 'token-bbbb']);
    expect(events.map((e) => e.type)).toEqual(['failover', 'used']);
    expect(events[0].code).toBe('QUOTA_EXCEEDED');
    expect(pool.isCooling(hashToken('token-aaaa'))).toBe(true);

    // Next request goes straight to the second token.
    attempts.length = 0;
    await pool.withFailover(['token-aaaa', 'token-bbbb'], fn);
    expect(attempts).toEqual(['token-bbbb']);
  });

  test('non-token errors (e.g. NOT_FOUND) are thrown, not failed over', async () => {
    quotas = { 'token-aaaa': quota(50), 'token-bbbb': quota(50) };
    const attempts = [];
    await expect(
      pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => {
        attempts.push(t);
        throw new FebBoxError('missing', 'NOT_FOUND');
      })
    ).rejects.toThrow('missing');
    expect(attempts).toEqual(['token-aaaa']);
  });

  test('throws QUOTA_EXCEEDED when every token is exhausted', async () => {
    quotas = { 'token-aaaa': quota(0), 'token-bbbb': quota(0) };
    await expect(pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  test('a failed quota lookup (network) does not disqualify a token', async () => {
    quotas = { 'token-aaaa': new FebBoxError('timeout', 'UPSTREAM_TIMEOUT'), 'token-bbbb': quota(40) };
    const out = await pool.withFailover(['token-aaaa', 'token-bbbb'], async (t) => t);
    expect(out.result).toBe('token-aaaa');
  });

  test('inspectTokens returns hash prefixes and never raw tokens', async () => {
    quotas = { 'token-aaaa': quota(10), 'token-bbbb': quota(0) };
    const snaps = await pool.inspectTokens(['token-aaaa', 'token-bbbb']);
    expect(snaps.map((s) => s.status)).toEqual(['ok', 'exhausted']);
    expect(snaps[0].hash).toHaveLength(8);
    expect(JSON.stringify(snaps)).not.toContain('token-aaaa');
  });
});
