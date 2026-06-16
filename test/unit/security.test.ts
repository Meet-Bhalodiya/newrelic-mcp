import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountAccessError,
  AuthenticationError,
  AuthorizationError,
  NrqlValidationError,
  assertAllowedHost,
  assertAllowedOrigin,
  assertReadOnlyNrql,
  authorizeAccount,
  collectReferencedAccountIds,
  containsSecretBearingUrl,
  createOidcVerifier,
  ensureBoundedNrql,
  isComplexNrql,
  protectedResourceMetadata,
  redact,
  redactHeaders,
  verifyBearerToken,
  wwwAuthenticateHeader,
} from '../../src/security/index.js';

describe('NRQL security', () => {
  it('allows bounded reads and ignores keywords inside literals', () => {
    expect(
      assertReadOnlyNrql("FROM Log SELECT count(*) WHERE message = 'DELETE FROM Log'"),
    ).toContain('DELETE FROM Log');
    expect(ensureBoundedNrql('FROM Transaction SELECT count(*)', 100)).toMatch(/LIMIT 100$/);
    expect(ensureBoundedNrql('FROM Log SELECT count(*) -- trailing comment', 100)).toMatch(
      /comment\nLIMIT 100$/u,
    );
    expect(ensureBoundedNrql('SHOW EVENT TYPES')).toBe('SHOW EVENT TYPES');
    expect(assertReadOnlyNrql('EXPLAIN FROM Transaction SELECT count(*)')).toMatch(/^EXPLAIN/);
    expect(isComplexNrql('FROM Transaction SELECT count(*) FACET appName TIMESERIES')).toBe(true);
  });

  it.each([
    'DELETE FROM Log WHERE true',
    'FROM Log SELECT count(*); DELETE FROM Log',
    'UPDATE Metric SET value = 0',
    'FROM Log SELECT count(*) LIMIT MAX',
  ])('rejects unsafe NRQL: %s', (query) => {
    const call = () =>
      query.includes('LIMIT') ? ensureBoundedNrql(query) : assertReadOnlyNrql(query);
    expect(call).toThrow(NrqlValidationError);
  });
});

describe('redaction and tenant isolation', () => {
  it('deeply redacts sensitive fields, headers, token-shaped text, and cycles', () => {
    const cyclic: Record<string, unknown> = {
      apiKey: 'NRAK-secret',
      note: 'Bearer abcdef',
      query: 'FROM Log',
    };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({
      apiKey: '[REDACTED]',
      note: '[REDACTED]',
      query: '[REDACTED]',
      self: '[CIRCULAR]',
    });
    expect(redactHeaders({ authorization: 'Bearer secret', accept: 'application/json' })).toEqual({
      authorization: '[REDACTED]',
      accept: 'application/json',
    });
    expect(
      redact({
        note: 'contact operator@example.com',
        url: 'https://bucket.example/object?X-Amz-Signature=top-secret&X-Amz-Credential=value',
      }),
    ).toEqual({ note: 'contact [REDACTED]', url: '[REDACTED]' });
    expect(redact({ url: 'https://user:password@example.com/hook' })).toEqual({
      url: '[REDACTED]',
    });
    expect(containsSecretBearingUrl('https://example.com/hook?token=secret')).toBe(true);
    expect(containsSecretBearingUrl('https://example.com/public?view=compact')).toBe(false);
  });

  it('resolves the default account and rejects an out-of-scope account', () => {
    expect(authorizeAccount(42, { accountAllowlist: [] })).toBe(42);
    expect(authorizeAccount(undefined, { defaultAccountId: 42, accountAllowlist: [42] })).toBe(42);
    expect(() => authorizeAccount(43, { accountAllowlist: [42] })).toThrow(AccountAccessError);
    expect(
      collectReferencedAccountIds({
        targetAccountId: 42,
        maintenanceWindow: { scope: { type: 'ACCOUNT', id: '43' } },
        managedAccount: { id: 44 },
        iamParent: { id: '45', scope: 'ACCOUNT' },
      }),
    ).toEqual([42, 43, 44, 45]);
  });
});

describe('HTTP authentication boundaries', () => {
  it('performs strict bearer parsing and constant-time comparison', () => {
    expect(() => verifyBearerToken('Bearer expected', 'expected')).not.toThrow();
    expect(() => verifyBearerToken('Basic expected', 'expected')).toThrow(AuthenticationError);
    expect(() => verifyBearerToken('Bearer wrong', 'expected')).toThrow(AuthenticationError);
  });

  it('rejects DNS rebinding hosts and supplied origins unless explicitly allowed', () => {
    expect(() => assertAllowedHost('localhost:3000', ['localhost'])).not.toThrow();
    expect(() => assertAllowedHost('evil.example:3000', ['localhost'])).toThrow(AuthorizationError);
    expect(() => assertAllowedOrigin(undefined, [])).not.toThrow();
    expect(() =>
      assertAllowedOrigin('https://client.example', ['https://client.example']),
    ).not.toThrow();
    expect(() => assertAllowedOrigin('null', ['null'])).toThrow(AuthorizationError);
  });

  it('verifies signature, issuer, audience, expiry, and scopes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test';
    jwk.alg = 'RS256';
    const verifier = await createOidcVerifier({
      issuer: 'https://issuer.example/',
      audience: 'newrelic-mcp',
      algorithms: ['RS256'],
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
    });
    const token = await new SignJWT({ scope: 'newrelic:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://issuer.example/')
      .setAudience('newrelic-mcp')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifier.verifyToken(token, ['newrelic:read'])).resolves.toMatchObject({
      subject: 'user-1',
    });
    await expect(verifier.verifyToken(token, ['newrelic:admin'])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const wrongAudience = await new SignJWT({ scope: 'newrelic:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://issuer.example/')
      .setAudience('other')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifier.verifyToken(wrongAudience)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects symmetric JWT algorithms and oversized discovery metadata', async () => {
    await expect(
      createOidcVerifier({
        issuer: 'https://issuer.example/',
        audience: 'newrelic-mcp',
        algorithms: ['HS256'],
        jwksUri: 'https://issuer.example/jwks',
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('x', { status: 200, headers: { 'content-length': String(300 * 1024) } }),
      );
    await expect(
      createOidcVerifier({
        issuer: 'https://issuer.example/',
        audience: 'newrelic-mcp',
        fetch,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('builds RFC 9728 metadata and discovery challenges', () => {
    expect(
      protectedResourceMetadata('https://mcp.example/mcp', 'https://id.example/'),
    ).toMatchObject({
      resource: 'https://mcp.example/mcp',
      scopes_supported: ['newrelic:read', 'newrelic:write', 'newrelic:admin'],
    });
    expect(wwwAuthenticateHeader('https://mcp.example/mcp', { error: 'invalid_token' })).toContain(
      'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
