'use strict';

const { encodeConfigToken, decodeConfigToken, hashToken } = require('../../src/config/configToken');

const SECRET = 'test-secret-at-least-16-chars';

describe('configToken', () => {
  test('round-trips a payload', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123', quality: { max: '1080p' } }, SECRET);
    const decoded = decodeConfigToken(token, SECRET);
    expect(decoded.febboxToken).toBe('abc123');
    expect(decoded.quality.max).toBe('1080p');
    expect(typeof decoded.createdAt).toBe('number');
  });

  test('rejects tampered ciphertext', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123' }, SECRET);
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decodeConfigToken(tampered, SECRET)).toThrow();
  });

  test('rejects decoding with wrong secret', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123' }, SECRET);
    expect(() => decodeConfigToken(token, 'a-completely-different-secret')).toThrow();
  });

  test('throws without a secret and no env var set', () => {
    const original = process.env.CONFIG_SECRET;
    delete process.env.CONFIG_SECRET;
    expect(() => encodeConfigToken({ febboxToken: 'abc' })).toThrow(/CONFIG_SECRET/);
    if (original) process.env.CONFIG_SECRET = original;
  });

  test('throws on empty febboxToken', () => {
    expect(() => encodeConfigToken({ febboxToken: '' }, SECRET)).toThrow();
  });

  test('does not embed the raw token in a recognizable way', () => {
    const token = encodeConfigToken({ febboxToken: 'super-secret-token-value' }, SECRET);
    expect(token).not.toContain('super-secret-token-value');
  });

  test('hashToken is deterministic and one-way-looking', () => {
    const h1 = hashToken('my-token');
    const h2 = hashToken('my-token');
    expect(h1).toBe(h2);
    expect(h1).not.toBe('my-token');
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('multiple FebBox tokens in one config', () => {
  const { getInstallId, MAX_TOKENS } = require('../../src/config/configToken');

  test('round-trips an ordered token list and exposes the first as febboxToken', () => {
    const token = encodeConfigToken({ febboxTokens: ['first-token-1', 'second-token-2'], label: 'TV' }, SECRET);
    const decoded = decodeConfigToken(token, SECRET);
    expect(decoded.febboxTokens).toEqual(['first-token-1', 'second-token-2']);
    expect(decoded.febboxToken).toBe('first-token-1');
    expect(decoded.label).toBe('TV');
  });

  test('legacy single febboxToken payloads decode into a one-item list', () => {
    const decoded = decodeConfigToken(encodeConfigToken({ febboxToken: 'abc123' }, SECRET), SECRET);
    expect(decoded.febboxTokens).toEqual(['abc123']);
  });

  test('dedupes, trims and caps the list', () => {
    const many = Array.from({ length: MAX_TOKENS + 3 }, (_, i) => `token-number-${i}`);
    const decoded = decodeConfigToken(encodeConfigToken({ febboxTokens: [' dup-token-1 ', 'dup-token-1', ...many] }, SECRET), SECRET);
    expect(decoded.febboxTokens).toHaveLength(MAX_TOKENS);
    expect(decoded.febboxTokens[0]).toBe('dup-token-1');
  });

  test('install id is stable for the same ordered tokens and differs otherwise', () => {
    expect(getInstallId(['a', 'b'])).toBe(getInstallId(['a', 'b']));
    expect(getInstallId(['a', 'b'])).not.toBe(getInstallId(['b', 'a']));
    expect(getInstallId(['a', 'b'])).toHaveLength(12);
  });
});
