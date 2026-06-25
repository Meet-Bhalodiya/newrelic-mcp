import { once } from 'node:events';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApp } from '../../src/http.js';
import type { Runtime } from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';
import { createMockRuntime } from '../helpers/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
const bearerToken = 'integration-token'.padEnd(32, '-');

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(async (close) => await close()));
});

async function listen(transformRuntime: (runtime: Runtime) => Runtime = (runtime) => runtime) {
  const mock = createMockRuntime({
    MCP_AUTH_MODE: 'bearer',
    MCP_BEARER_TOKEN: bearerToken,
    MCP_HTTP_MAX_BODY_BYTES: '1024',
  });
  const runtime = transformRuntime(mock.runtime);
  const app = await createHttpApp(runtime, (requestContext) =>
    createMcpServer(runtime, requestContext),
  );
  const httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    async () =>
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  );
  return { ...mock, runtime, baseUrl };
}

async function connectClient(baseUrl: string): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
  });
  // SDK 1.29 does not model exactOptionalPropertyTypes on this transport declaration.
  await client.connect(transport as unknown as Transport);
  cleanup.push(async () => await client.close());
  return client;
}

describe('stateless Streamable HTTP', () => {
  it('serves an authenticated MCP client with the official SDK transport', async () => {
    const { baseUrl } = await listen();
    const client = await connectClient(baseUrl);
    expect((await client.listTools()).tools).toHaveLength(39);

    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toContain('newrelic://server/capabilities');
    const capabilities = await client.readResource({
      uri: 'newrelic://server/capabilities',
    });
    expect(capabilities.contents[0]).toMatchObject({
      uri: 'newrelic://server/capabilities',
      mimeType: 'application/json',
    });

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toContain(
      'newrelic://entities/{guid}',
    );
    const entity = await client.readResource({ uri: 'newrelic://entities/ENTITY' });
    const entityContent = entity.contents[0];
    if (entityContent === undefined || !('text' in entityContent)) {
      throw new Error('Expected JSON entity resource content');
    }
    expect(JSON.parse(entityContent.text)).toMatchObject({
      ok: true,
      data: { actor: { entity: { guid: 'ENTITY', accountId: 42 } } },
    });

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(({ name }) => name)).toContain('incident_triage');
    const prompt = await client.getPrompt({
      name: 'incident_triage',
      arguments: { accountId: '42', lookback: '1 hour' },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });

    const result = await client.callTool({ name: 'connection_check', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      meta: { region: 'US', partial: false, truncated: false },
    });
    if (!Array.isArray(result.content)) throw new Error('Expected MCP tool content');
    const first = result.content[0];
    if (
      first === undefined ||
      first.type !== 'text' ||
      !('text' in first) ||
      typeof first.text !== 'string'
    ) {
      throw new Error('Expected serialized JSON tool content');
    }
    expect(JSON.parse(first.text)).toEqual(result.structuredContent);
  });

  it('cancels an in-flight HTTP tool upstream through the official SDK', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let upstreamAborted = false;
    const { baseUrl } = await listen(
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
    const client = await connectClient(baseUrl);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'connection_check', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await upstreamStarted;
    const cancellationStartedAt = performance.now();
    controller.abort('integration test cancellation');

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
    expect(performance.now() - cancellationStartedAt).toBeLessThan(1_000);
  });

  it('aborts an in-flight upstream when the HTTP caller disconnects', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let upstreamAborted = false;
    const { baseUrl } = await listen(
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
                  reject(new DOMException('disconnected', 'AbortError'));
                };
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              }),
          },
        }) as unknown as Runtime,
    );
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'disconnect-test',
        method: 'tools/call',
        params: { name: 'connection_check', arguments: {} },
      }),
      signal: controller.signal,
    });
    await upstreamStarted;
    const disconnectStartedAt = performance.now();
    controller.abort();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
    expect(performance.now() - disconnectStartedAt).toBeLessThan(1_000);
  });

  it('rejects missing auth, hostile origins, and oversized bodies', async () => {
    const { baseUrl } = await listen();
    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');

    const hostileOrigin = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearerToken}`, origin: 'https://evil.example' },
    });
    expect(hostileOrigin.status).toBe(403);

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'x'.repeat(2048) }),
    });
    expect(oversized.status).toBe(413);
  });
});
