import { describe, expect, it } from 'vitest';

import {
  assertHeaderMatches,
  deserializeSession,
  envelopeKind,
  encryptedHeaderOf,
  serializeEncryptedSession,
  serializeSession,
  validateSessionRecord,
} from '../../src/session/session-serializer.js';
import { StaticSessionKeyProvider } from '../../src/session/session-encryption.js';
import { SessionSerializationError } from '../../src/session/session-errors.js';
import { SessionTokenManager } from '../../src/session/session-token.js';
import { SessionKeyStrategy, encodeUserId } from '../../src/session/session-keys.js';
import { SessionCookieManager } from '../../src/session/session-cookie.js';
import { SessionMetrics } from '../../src/session/session-metrics.js';
import type { SessionRecord } from '../../src/session/session-types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    jti: 'a'.repeat(43),
    userId: 'user-1',
    createdAt: 1_700_000_000,
    lastAccessedAt: 1_700_000_000,
    absoluteExpiresAt: 1_700_086_400,
    idleExpiresAt: 1_700_086_400,
    status: 'active',
    version: 1,
    securityVersion: null,
    deviceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: null,
    rotatedFrom: null,
    rotatedTo: null,
    consumedAt: null,
    rotationNonceHash: null,
    ...overrides,
  };
}

describe('session serializer', () => {
  it('round-trips a plain envelope', () => {
    const record = makeRecord();
    const raw = serializeSession(record);
    expect(envelopeKind(raw)).toBe('plain');
    expect(deserializeSession(raw)).toEqual(record);
  });

  it('round-trips an encrypted envelope', () => {
    const provider = new StaticSessionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const record = makeRecord();
    const raw = serializeEncryptedSession(record, provider);
    expect(envelopeKind(raw)).toBe('encrypted');
    expect(deserializeSession(raw, provider)).toEqual(record);
  });

  it('rejects unknown schema versions', () => {
    expect(() => deserializeSession('{"v":99}')).toThrow(SessionSerializationError);
    expect(() => deserializeSession('not-json')).toThrow(SessionSerializationError);
  });

  it('rejects encrypted envelopes without a provider', () => {
    const provider = new StaticSessionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const raw = serializeEncryptedSession(makeRecord(), provider);
    expect(() => deserializeSession(raw)).toThrow(SessionSerializationError);
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const provider = new StaticSessionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const record = makeRecord();
    const raw = serializeEncryptedSession(record, provider);
    const env = JSON.parse(raw) as { c: string };
    // Flip one base64url char of the ciphertext.
    const flipped = env.c[0] === 'A' ? 'B' : 'A';
    env.c = flipped + env.c.slice(1);
    expect(() => deserializeSession(JSON.stringify(env), provider)).toThrow(SessionSerializationError);
  });

  it('rejects records encrypted with an unknown key version', () => {
    const provider = new StaticSessionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const raw = serializeEncryptedSession(makeRecord(), provider);
    const env = JSON.parse(raw) as { k: number };
    env.k = 42;
    expect(() => deserializeSession(JSON.stringify(env), provider)).toThrow(SessionSerializationError);
  });

  it('detects header/ciphertext disagreement (fail closed)', () => {
    const provider = new StaticSessionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const record = makeRecord({ lastAccessedAt: 1_700_000_000, version: 1 });

    // Header mirror says version 5, record says 1: tampered or stale write.
    const env = JSON.parse(serializeEncryptedSession(record, provider)) as { ver: number };
    env.ver = 5;

    const decrypted = deserializeSession(JSON.stringify(env), provider);
    expect(decrypted.version).toBe(1);
    expect(() =>
      assertHeaderMatches(JSON.parse(JSON.stringify(env)), decrypted),
    ).toThrow(SessionSerializationError);
  });

  it('validateSessionRecord rejects malformed records', () => {
    expect(() => validateSessionRecord(null)).toThrow(SessionSerializationError);
    expect(() => validateSessionRecord({ jti: 'short' })).toThrow(SessionSerializationError);
    const record = makeRecord({ absoluteExpiresAt: -5 });
    expect(() => validateSessionRecord(record)).toThrow(SessionSerializationError);
  });

  it('rejects metadata beyond allowed depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(() => validateSessionRecord(makeRecord({ metadata: deep }))).toThrow(
      SessionSerializationError,
    );
  });
});

describe('session token manager', () => {
  const manager = new SessionTokenManager(32);

  it('generates base64url tokens of the configured entropy', () => {
    const token = manager.generate();
    expect(manager.validateFormat(token)).toBe(true);
    expect(token.length).toBe(Math.ceil((32 * 4) / 3));
  });

  it('hashes deterministically and never exposes the token', () => {
    const token = manager.generate();
    const jti = manager.hash(token);
    expect(jti).toBe(manager.hash(token));
    expect(jti).not.toContain(token);
    expect(manager.validateFormat(jti)).toBe(true);
  });

  it('rejects malformed tokens', () => {
    expect(manager.validateFormat('')).toBe(false);
    expect(manager.validateFormat('short')).toBe(false);
    expect(manager.validateFormat('not-base64url!!!')).toBe(false);
    expect(manager.validateFormat('a'.repeat(200))).toBe(false);
  });

  it('safeEquals is constant-time and correct', () => {
    const a = manager.hash(manager.generate());
    const b = manager.hash(manager.generate());
    expect(manager.safeEquals(a, a)).toBe(true);
    expect(manager.safeEquals(a, b)).toBe(false);
  });
});

describe('session key strategy', () => {
  const keys = new SessionKeyStrategy('authcore');

  it('hash-tags user-scoped keys consistently', () => {
    const userId = 'user:with:colons and spaces';
    const encoded = encodeUserId(userId);
    expect(encoded).not.toContain('{');

    const sessionKey = keys.sessionKey(userId, 'jti123');
    const indexKey = keys.userIndexKey(userId);
    const prefix = keys.sessionKeyPrefix(userId);

    // Same hash tag => same slot on Cluster.
    const tag = (k: string) => k.match(/\{([^}]+)\}/)?.[1];
    expect(tag(sessionKey)).toBe(encoded);
    expect(tag(indexKey)).toBe(encoded);
    expect(prefix + 'jti123').toBe(sessionKey);
  });

  it('does not hash-tag cross-slot keys', () => {
    expect(keys.jtiIndexKey('jti123')).toContain('jti-index:');
    expect(keys.jtiIndexKey('jti123')).not.toContain('{');
    expect(keys.revokedKey('jti123')).toContain('revoked:');
    expect(keys.revokedKey('jti123')).not.toContain('{');
  });

  it('encodeUserId percent-encodes unsafe bytes and keeps safe ones', () => {
    expect(encodeUserId('plain-user-1')).toBe('plain-user-1');
    expect(encodeUserId('a b')).toBe('a%20b');
    expect(encodeUserId('x{y')).toBe('x%7by');
    expect(encodeUserId('u:*[x]')).toMatch(/^u%3a%2a%5bx%5d$/);
  });

  it('rejects namespaces with metacharacters', () => {
    expect(() => new SessionKeyStrategy('bad {tag}')).toThrow();
    expect(() => new SessionKeyStrategy('bad:ns:*')).toThrow();
  });
});

describe('session cookie manager', () => {
  const cookies = new SessionCookieManager({
    name: 'sid',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });

  it('serializes a Set-Cookie with secure defaults', () => {
    const header = cookies.serialize('tok123', { maxAge: 3600 });
    expect(header).toContain('sid=tok123');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=3600');
  });

  it('returns the structured cookie object alongside the header', () => {
    const cookie = cookies.serializeWithAttributes('tok123', { maxAge: 3600, path: '/app' });
    expect(cookie.header).toBe(cookies.serialize('tok123', { maxAge: 3600, path: '/app' }));
    expect(cookie.name).toBe('sid');
    expect(cookie.value).toBe('tok123');
    expect(cookie.attributes).toEqual({
      path: '/app',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 3600,
    });
  });

  it('omits optional attributes when not configured', () => {
    const plain = new SessionCookieManager({
      name: 'sid',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'none',
    });
    const cookie = plain.serializeWithAttributes('tok123');
    expect(cookie.attributes).toEqual({
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'none',
    });
    expect(cookie.header).not.toContain('Max-Age');
  });

  it('clears by expiring the cookie', () => {
    const header = cookies.clear();
    expect(header).toContain('sid=');
    expect(header).toContain('Max-Age=0');
  });

  it('parses the cookie out of a header', () => {
    expect(cookies.parse('other=1; sid=tok123; x=2')).toBe('tok123');
    expect(cookies.parse('sid=')).toBeNull();
    expect(cookies.parse(null)).toBeNull();
    expect(cookies.parse('other=1')).toBeNull();
  });
});

describe('session metrics (no-op without adapter)', () => {
  it('never throws without an adapter', () => {
    const metrics = new SessionMetrics();
    expect(() => {
      metrics.operation('validate', 'ok');
      metrics.latency('create', 1);
      metrics.breakerState('open');
      metrics.revocationMiss();
      metrics.encryptionError('tag');
    }).not.toThrow();
  });

  it('forwards to an adapter', () => {
    const calls: string[] = [];
    const metrics = new SessionMetrics({
      incCounter: (name, delta, attrs) => {
        calls.push(`inc:${name}:${delta}:${JSON.stringify(attrs)}`);
      },
      recordHistogram: (name, value) => calls.push(`hist:${name}:${value}`),
      setGauge: (name, value) => calls.push(`gauge:${name}:${value}`),
    });
    metrics.operation('validate', 'invalid', 'expired');
    metrics.latency('create', 12);
    metrics.breakerState('open');
    expect(calls.join('\n')).toContain('inc:session.validate.total:1:{"outcome":"invalid","code":"expired"}');
    expect(calls.join('\n')).toContain('hist:session.create.duration_ms:12');
  });
});

describe('encryptedHeaderOf', () => {
  it('mirrors the script-readable fields', () => {
    const record = makeRecord({ version: 3, status: 'consumed', rotatedTo: 'b'.repeat(43) });
    expect(encryptedHeaderOf(record)).toEqual({
      st: 'consumed',
      ver: 3,
      la: record.lastAccessedAt,
      idle: record.idleExpiresAt,
      exp: record.absoluteExpiresAt,
      rn: null,
      rj: 'b'.repeat(43),
    });
  });
});
