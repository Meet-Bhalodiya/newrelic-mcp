import { generateKeyPairSync } from 'node:crypto';

import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { normalizePublicError } from '../../src/error-mapping.js';
import { NerdGraphClient, type NerdGraphOperation } from '../../src/newrelic/index.js';
import { AuthenticationError, createOidcVerifier } from '../../src/security/index.js';

function createClient(
  fetch: typeof globalThis.fetch,
  options: { allowMutations?: boolean; endpoint?: string } = {},
): NerdGraphClient {
  return new NerdGraphClient({
    apiKey: 'NRAK-do-not-leak-this-value',
    endpoint: options.endpoint ?? 'https://api.newrelic.com/graphql',
    region: 'US',
    maxReadRetries: 0,
    allowMutations: options.allowMutations ?? false,
    fetch,
  });
}

describe('injection and network boundaries', () => {
  it('keeps hostile values in GraphQL variables and never changes the fixed document', async () => {
    const fixedDocument =
      'query InjectionTest($search: String!) { actor { entitySearch(query: $search) { count } } }';
    const hostile = `service') } mutation DeleteEverything { accountManagementCancelAccount(id: 1) { __typename } } #`;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { search: string };
      };
      expect(body.query).toBe(fixedDocument);
      expect(body.variables.search).toBe(hostile);
      return Promise.resolve(
        new Response('{"data":{"actor":{"entitySearch":{"count":0}}}}', { status: 200 }),
      );
    });
    const operation: NerdGraphOperation<
      { search: string },
      { actor: { entitySearch: { count: number } } }
    > = {
      operationName: 'InjectionTest',
      kind: 'query',
      document: fixedDocument,
      variablesSchema: z.object({ search: z.string() }),
      dataSchema: z.object({
        actor: z.object({ entitySearch: z.object({ count: z.number() }) }),
      }),
    };
    await expect(
      createClient(fetch).execute(operation, { search: hostile }),
    ).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects operation-kind spoofing, mutation bypasses, and SSRF endpoints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const mutation: NerdGraphOperation<Record<string, never>, Record<string, unknown>> = {
      operationName: 'BlockedMutation',
      kind: 'mutation',
      document: 'mutation BlockedMutation { blocked }',
      variablesSchema: z.object({}).strict(),
      dataSchema: z.record(z.string(), z.unknown()),
    };
    await expect(createClient(fetch).execute(mutation, {})).rejects.toMatchObject({
      code: 'write-disabled',
    });
    await expect(
      createClient(fetch, { allowMutations: true }).execute({ ...mutation, kind: 'query' }, {}),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createClient(fetch, {
        endpoint: 'http://169.254.169.254/latest/meta-data/iam/security-credentials',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('does not expose credentials embedded in low-level failure paths', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error('socket failure for NRAK-do-not-leak-this-value')),
    );
    const operation: NerdGraphOperation<Record<string, never>, { actor: object }> = {
      operationName: 'SecretFailure',
      kind: 'query',
      document: 'query SecretFailure { actor { __typename } }',
      variablesSchema: z.object({}).strict(),
      dataSchema: z.object({ actor: z.object({}).loose() }),
    };
    const failure = await createClient(fetch)
      .execute(operation, {})
      .catch((error: unknown) => error);
    const publicFailure = normalizePublicError(failure).toPublic();
    expect(JSON.stringify(publicFailure)).not.toContain('NRAK-do-not-leak-this-value');
    expect(publicFailure).toMatchObject({ code: 'upstream', retryable: true });
  });
});

describe('OIDC expiration boundary', () => {
  it('rejects a correctly signed but expired access token', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'expired-test';
    jwk.alg = 'RS256';
    const verifier = await createOidcVerifier({
      issuer: 'https://issuer.example/',
      audience: 'newrelic-mcp',
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: 'newrelic:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'expired-test' })
      .setIssuer('https://issuer.example/')
      .setAudience('newrelic-mcp')
      .setSubject('expired-user')
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(privateKey);
    await expect(verifier.verifyToken(token, ['newrelic:read'])).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });
});
