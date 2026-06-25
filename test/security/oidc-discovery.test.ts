import { generateKeyPairSync } from 'node:crypto';

import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { AuthenticationError, createOidcVerifier } from '../../src/security/index.js';

const issuer = 'https://issuer.example/tenant';
const discoveryUrl = 'https://issuer.example/tenant/.well-known/openid-configuration';
const jwksUrl = 'https://issuer.example/jwks';

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

describe('OIDC discovery and remote JWKS failures', () => {
  it('fails closed for unreachable, unsuccessful, invalid, and mismatched discovery', async () => {
    const unreachable = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('offline')));
    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch: unreachable }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(urlOf(unreachable.mock.calls[0]![0])).toBe(discoveryUrl);

    const unsuccessful = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch: unsuccessful }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const invalidJson = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{not-json', { status: 200 }));
    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch: invalidJson }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const mismatchedIssuer = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ issuer: 'https://attacker.example/', jwks_uri: jwksUrl }));
    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch: mismatchedIssuer }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const insecureJwks = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ issuer, jwks_uri: 'http://issuer.example/jwks' }));
    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch: insecureJwks }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects discovery documents over the strict metadata size limit', async () => {
    const oversizedDocument = JSON.stringify({
      issuer,
      jwks_uri: jwksUrl,
      padding: 'x'.repeat(70 * 1024),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(oversizedDocument, { status: 200 }));

    await expect(
      createOidcVerifier({ issuer, audience: 'resource', fetch }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('normalizes remote JWKS transport and oversized-response failures', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const accessToken = await new SignJWT({ scope: 'newrelic:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'remote-test' })
      .setIssuer(issuer)
      .setAudience('resource')
      .setSubject('remote-jwks-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const unavailableJwks = vi.fn<typeof globalThis.fetch>((input) => {
      if (urlOf(input) === discoveryUrl) {
        return Promise.resolve(Response.json({ issuer, jwks_uri: jwksUrl }));
      }
      expect(urlOf(input)).toBe(jwksUrl);
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    });
    const unavailableVerifier = await createOidcVerifier({
      issuer,
      audience: 'resource',
      algorithms: ['RS256'],
      fetch: unavailableJwks,
    });
    await expect(unavailableVerifier.verifyToken(accessToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(unavailableJwks).toHaveBeenCalledTimes(2);

    const oversizedJwks = vi.fn<typeof globalThis.fetch>((input) => {
      if (urlOf(input) === discoveryUrl) {
        return Promise.resolve(Response.json({ issuer, jwks_uri: jwksUrl }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [], padding: 'x'.repeat(300 * 1024) }), {
          status: 200,
        }),
      );
    });
    const oversizedVerifier = await createOidcVerifier({
      issuer,
      audience: 'resource',
      algorithms: ['RS256'],
      fetch: oversizedJwks,
    });
    await expect(oversizedVerifier.verifyToken(accessToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('accepts a valid discovery document and matching remote JWKS without external I/O', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'valid-remote-test';
    jwk.alg = 'RS256';
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (urlOf(input) === discoveryUrl) {
        return Promise.resolve(Response.json({ issuer, jwks_uri: jwksUrl }));
      }
      expect(urlOf(input)).toBe(jwksUrl);
      return Promise.resolve(Response.json({ keys: [jwk] }));
    });
    const verifier = await createOidcVerifier({
      issuer,
      audience: 'resource',
      algorithms: ['RS256'],
      fetch,
    });
    const accessToken = await new SignJWT({ scp: ['newrelic:read', 'newrelic:admin'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'valid-remote-test' })
      .setIssuer(issuer)
      .setAudience('resource')
      .setSubject('valid-remote-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifier.verifyToken(accessToken, ['newrelic:admin'])).resolves.toMatchObject({
      subject: 'valid-remote-user',
      audience: ['resource'],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
});
