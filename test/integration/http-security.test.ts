import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { exportJWK, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeHttpServer, createHttpApp, startHttpServer } from '../../src/http.js';
import type { Runtime } from '../../src/runtime.js';
import { createMcpServer, type McpRequestSignalContext } from '../../src/server.js';
import { createMockRuntime } from '../helpers/runtime.js';

const issuer = 'https://issuer.example/';
const audience = 'newrelic-mcp';
const resourceUrl = 'https://mcp.example/mcp';
const jwksUrl = 'https://issuer.example/jwks';
const nativeFetch = globalThis.fetch.bind(globalThis);
const cleanup: (() => Promise<void>)[] = [];

let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
let publicJwk: JWK;

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'http-security-test';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
});

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(async (close) => await close()));
  vi.unstubAllGlobals();
});

function inputUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function installJwksRouter(): void {
  const routedFetch: typeof globalThis.fetch = async (input, init) => {
    if (inputUrl(input) === jwksUrl) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return await nativeFetch(input, init);
  };
  vi.stubGlobal('fetch', routedFetch);
}

async function token(
  scopes: readonly string[],
  overrides: { issuer?: string; audience?: string; expiresIn?: string; subject?: string } = {},
): Promise<string> {
  return await new SignJWT({ scope: scopes.join(' ') })
    .setProtectedHeader({ alg: 'RS256', kid: 'http-security-test' })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? 'http-security-user')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(privateKey);
}

type RunningApp = {
  readonly runtime: Runtime;
  readonly server: HttpServer;
  readonly baseUrl: string;
};

async function listenOidc(
  serverFactory: (
    runtime: Runtime,
    requestContext?: McpRequestSignalContext,
  ) => McpServer = createMcpServer,
  transformRuntime: (runtime: Runtime) => Runtime = (runtime) => runtime,
): Promise<RunningApp> {
  installJwksRouter();
  const mock = createMockRuntime({
    MCP_AUTH_MODE: 'oidc',
    MCP_OIDC_ISSUER: issuer,
    MCP_OIDC_AUDIENCE: audience,
    MCP_OIDC_JWKS_URI: jwksUrl,
    MCP_OIDC_ALGORITHMS: 'RS256',
    MCP_OIDC_RESOURCE_URL: resourceUrl,
    MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    MCP_HTTP_ALLOWED_ORIGINS: 'https://client.example',
    MCP_HTTP_MAX_BODY_BYTES: '4096',
    MCP_METRICS_ENABLED: 'true',
    NEW_RELIC_TOOLSETS: 'core,entities,admin',
    NEW_RELIC_ENABLE_WRITES: 'true',
    NEW_RELIC_ENABLE_ADMIN: 'true',
  });
  const runtime = transformRuntime(mock.runtime);
  const app = await createHttpApp(runtime, (requestContext) =>
    serverFactory(runtime, requestContext),
  );
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  cleanup.push(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
  return { runtime, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function connectClient(baseUrl: string, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'http-security-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  // SDK 1.29 does not model exactOptionalPropertyTypes on this transport declaration.
  await client.connect(transport as unknown as Transport);
  cleanup.push(async () => await client.close());
  return client;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (
    result.structuredContent === undefined ||
    result.structuredContent === null ||
    typeof result.structuredContent !== 'object' ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error('Expected structured tool content');
  }
  return result.structuredContent as Record<string, unknown>;
}

async function rawGetStatus(url: string, hostHeader: string): Promise<number | undefined> {
  const target = new URL(url);
  return await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { host: hostHeader, connection: 'close' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describe('OIDC-protected Streamable HTTP', () => {
  it('publishes RFC 9728 metadata and advertises discovery on authentication failures', async () => {
    const { baseUrl } = await listenOidc();

    const metadata = await nativeFetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('cache-control')).toBe('no-store');
    expect(metadata.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(metadata.json()).resolves.toEqual({
      resource: resourceUrl,
      authorization_servers: [issuer],
      scopes_supported: ['newrelic:read', 'newrelic:write', 'newrelic:admin'],
      bearer_methods_supported: ['header'],
      resource_name: 'New Relic MCP Server',
    });

    const unauthenticated = await nativeFetch(`${baseUrl}/mcp`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(unauthenticated.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(unauthenticated.headers.get('www-authenticate')).toContain('scope="newrelic:read"');

    const writeOnly = await nativeFetch(`${baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${await token(['newrelic:write'])}` },
    });
    expect(writeOnly.status).toBe(403);
    expect(writeOnly.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(writeOnly.headers.get('www-authenticate')).toContain('scope="newrelic:read"');
  });

  it('returns HTTP scope challenges for write and admin step-up consent', async () => {
    const { baseUrl } = await listenOidc();
    const accessToken = await token(['newrelic:read']);
    for (const [name, requiredScope] of [
      ['entity_tags_add', 'newrelic:write'],
      ['organization_get', 'newrelic:admin'],
    ] as const) {
      const response = await nativeFetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(response.headers.get('www-authenticate')).toContain(`scope="${requiredScope}"`);
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    }

    const batch = await nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 'read',
          method: 'tools/call',
          params: { name: 'connection_check', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 'write',
          method: 'tools/call',
          params: { name: 'entity_tags_add', arguments: {} },
        },
      ]),
    });
    expect(batch.status).toBe(403);
    expect(batch.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(batch.headers.get('www-authenticate')).toContain('newrelic:write');
  });

  it('rejects wrong issuer and audience without reflecting bearer credentials', async () => {
    const { baseUrl } = await listenOidc();
    const wrongIssuer = await token(['newrelic:read'], { issuer: 'https://other-issuer.example/' });
    const wrongAudience = await token(['newrelic:read'], { audience: 'another-resource' });

    for (const accessToken of [wrongIssuer, wrongAudience]) {
      const response = await nativeFetch(`${baseUrl}/mcp`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(401);
      const responseText = await response.text();
      expect(responseText).toContain('unauthorized');
      expect(responseText).not.toContain(accessToken);
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
  });

  it('enforces read, write, and admin scopes at the tool boundary with the official SDK', async () => {
    const { baseUrl } = await listenOidc();
    const readClient = await connectClient(baseUrl, await token(['newrelic:read']));

    const readResult = structured(
      await readClient.callTool({ name: 'connection_check', arguments: {} }),
    );
    expect(readResult).toMatchObject({ ok: true });

    await expect(
      readClient.callTool({
        name: 'entity_tags_add',
        arguments: { guid: 'ENTITY', tags: [{ key: 'team', values: ['platform'] }] },
      }),
    ).rejects.toThrow(/403|scope|forbidden/iu);

    await expect(readClient.callTool({ name: 'organization_get', arguments: {} })).rejects.toThrow(
      /403|scope|forbidden/iu,
    );

    const writeClient = await connectClient(
      baseUrl,
      await token(['newrelic:read', 'newrelic:write']),
    );
    const writePreview = structured(
      await writeClient.callTool({
        name: 'entity_tags_add',
        arguments: { guid: 'ENTITY', tags: [{ key: 'team', values: ['platform'] }] },
      }),
    );
    expect(writePreview, JSON.stringify(writePreview)).toMatchObject({
      ok: true,
      data: { dryRun: true },
    });

    const adminClient = await connectClient(
      baseUrl,
      await token(['newrelic:read', 'newrelic:admin']),
    );
    const adminResult = structured(
      await adminClient.callTool({ name: 'organization_get', arguments: {} }),
    );
    expect(adminResult).toMatchObject({ ok: true });
  });

  it('never passes the caller bearer credential into MCP handler authInfo', async () => {
    const probeFactory = (): McpServer => {
      const server = new McpServer({ name: 'auth-probe', version: '1.0.0' });
      server.registerTool(
        'auth_probe',
        { description: 'Return only the transport authentication marker.', inputSchema: {} },
        (_arguments, extra) =>
          Promise.resolve({
            content: [{ type: 'text' as const, text: JSON.stringify(extra.authInfo) }],
          }),
      );
      return server;
    };
    const { baseUrl } = await listenOidc(probeFactory);
    const accessToken = await token(['newrelic:read']);
    const client = await connectClient(baseUrl, accessToken);
    const result = await client.callTool({ name: 'auth_probe', arguments: {} });
    if (!Array.isArray(result.content)) throw new Error('Expected tool content');
    const firstContent = result.content[0];
    if (
      firstContent === null ||
      typeof firstContent !== 'object' ||
      firstContent.type !== 'text' ||
      typeof firstContent.text !== 'string'
    ) {
      throw new Error('Expected text tool content');
    }
    const authInfo = JSON.parse(firstContent.text) as Record<string, unknown>;

    expect(authInfo).toMatchObject({
      token: '[verified]',
      clientId: 'http-security-user',
      scopes: ['newrelic:read'],
    });
    expect(JSON.stringify(authInfo)).not.toContain(accessToken);
  });

  it('scopes colliding request IDs and cancellation to the authenticated principal', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let upstreamAborted = false;
    const { baseUrl } = await listenOidc(
      createMcpServer,
      (runtime) =>
        ({
          ...runtime,
          executor: {
            execute: async (
              _operation: unknown,
              _variables: Record<string, unknown>,
              options?: { readonly signal?: AbortSignal },
            ) =>
              await new Promise<never>((_resolve, reject) => {
                const signal = options?.signal;
                if (signal === undefined) {
                  reject(new Error('Expected an upstream cancellation signal'));
                  return;
                }
                started();
                const abort = (): void => {
                  upstreamAborted = true;
                  reject(new DOMException('cancelled', 'AbortError'));
                };
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              }),
          },
        }) as unknown as Runtime,
    );
    const firstToken = await token(['newrelic:read'], { subject: 'first-principal' });
    const otherToken = await token(['newrelic:read'], { subject: 'other-principal' });
    const requestBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/call',
      params: { name: 'connection_check', arguments: {} },
    });
    const original = nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: requestBody,
    });
    await upstreamStarted;

    const collision = await nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: requestBody,
    });
    expect(collision.status).toBe(409);
    expect(upstreamAborted).toBe(false);

    const cancel = async (accessToken: string): Promise<Response> =>
      await nativeFetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 77, reason: 'test' },
        }),
      });

    expect((await cancel(otherToken)).status).toBe(202);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(upstreamAborted).toBe(false);

    expect((await cancel(firstToken)).status).toBe(202);
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
    expect((await original).status).toBe(200);
  });

  it('hardens Host, Origin, body parsing, methods, and metrics endpoints', async () => {
    const { baseUrl } = await listenOidc();
    const accessToken = await token(['newrelic:read']);
    const authorization = `Bearer ${accessToken}`;

    await expect(rawGetStatus(`${baseUrl}/healthz`, 'evil.example')).resolves.toBe(403);

    for (const origin of ['https://evil.example', 'null', 'not a URL']) {
      const response = await nativeFetch(`${baseUrl}/healthz`, { headers: { origin } });
      expect(response.status).toBe(403);
    }
    const allowedOrigin = await nativeFetch(`${baseUrl}/healthz`, {
      headers: { origin: 'https://client.example' },
    });
    await expect(allowedOrigin.json()).resolves.toEqual({ status: 'ok' });

    for (const method of ['GET', 'DELETE']) {
      const response = await nativeFetch(`${baseUrl}/mcp`, {
        method,
        headers: { authorization },
      });
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32_000 },
      });
    }

    const malformed = await nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32_700 } });

    const oversized = await nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(8192) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: -32_001 } });

    for (const contentType of ['application/json-patch+json', 'text/plain; x=application/json']) {
      const nonCanonical = await nativeFetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { authorization, 'content-type': contentType },
        body: JSON.stringify({ value: 'x'.repeat(8192) }),
      });
      expect(nonCanonical.status).toBe(415);
      await expect(nonCanonical.json()).resolves.toMatchObject({ error: { code: -32_000 } });
    }

    const protectedMetrics = await nativeFetch(`${baseUrl}/metrics`);
    expect(protectedMetrics.status).toBe(401);
    const metrics = await nativeFetch(`${baseUrl}/metrics`, { headers: { authorization } });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    const metricText = await metrics.text();
    expect(metricText).toContain('newrelic_mcp_tool_calls_total');
    expect(metricText).not.toContain(accessToken);
  });

  it('classifies server-construction failures as sanitized internal errors', async () => {
    const secretFailure = 'factory-failure-secret';
    const { baseUrl } = await listenOidc(() => {
      throw new Error(secretFailure);
    });
    const response = await nativeFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(['newrelic:read'])}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'factory-failure-test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('"code":-32603');
    expect(body).toContain('Internal server error');
    expect(body).not.toContain(secretFailure);
    expect(body).not.toContain('Invalid JSON request body');
  });
});

describe('HTTP server lifecycle', () => {
  it('starts on the configured interface and closes gracefully', async () => {
    const mock = createMockRuntime({
      MCP_AUTH_MODE: 'bearer',
      MCP_BEARER_TOKEN: 'lifecycle-token'.padEnd(32, '-'),
    });
    const runtime: Runtime = {
      ...mock.runtime,
      config: {
        ...mock.runtime.config,
        http: { ...mock.runtime.config.http, port: 0 },
      },
    };
    const server = await startHttpServer(runtime, (requestContext) =>
      createMcpServer(runtime, requestContext),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const healthUrl = `http://127.0.0.1:${address.port}/healthz`;

    const health = await nativeFetch(healthUrl);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    await closeHttpServer(server);
    expect(server.listening).toBe(false);
    await expect(nativeFetch(healthUrl)).rejects.toThrow();
  });
});
