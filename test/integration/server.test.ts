import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpServer } from '../../src/server.js';
import type { Runtime } from '../../src/runtime.js';
import { createMockRuntime } from '../helpers/runtime.js';

const closeCallbacks: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => await close()));
});

async function connect(environment: Record<string, string> = {}) {
  const mock = createMockRuntime(environment);
  const server = createMcpServer(mock.runtime);
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return { ...mock, client };
}

describe('MCP server capabilities', () => {
  it('initializes with safety instructions and discovers tools, resources, and prompts', async () => {
    const { client } = await connect();
    expect(client.getInstructions()?.slice(0, 512)).toContain('read-only by default');

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(39);
    expect(tools.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'connection_check',
        'nrql_query',
        'trace_get',
        'service_level_results',
      ]),
    );
    expect(tools.tools.map(({ name }) => name)).not.toContain('dashboard_delete');

    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toContain('newrelic://server/capabilities');
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toContain(
      'newrelic://entities/{guid}',
    );
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['incident_triage', 'service_health', 'synthetic_failure_analysis']),
    );
  });

  it('returns matching structured and JSON text results', async () => {
    const { client, operationNames } = await connect();
    const result = await client.callTool({ name: 'connection_check', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      meta: { region: 'US', partial: false, truncated: false },
    });
    const content = result.content as { type: string; text?: string }[];
    const text = content[0]?.type === 'text' ? (content[0].text ?? '{}') : '{}';
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(operationNames).toEqual(['ConnectionCheck']);
  });

  it('propagates official SDK cancellation to the in-flight upstream operation', async () => {
    const mock = createMockRuntime();
    let upstreamAborted = false;
    const runtime = {
      ...mock.runtime,
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
            const abort = (): void => {
              upstreamAborted = true;
              reject(new DOMException('cancelled', 'AbortError'));
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
      },
    } as unknown as Runtime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'cancellation-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const controller = new AbortController();
    const pending = client.callTool({ name: 'connection_check', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
  });

  it('uses one request ID across upstream execution and a public error envelope', async () => {
    const mock = createMockRuntime();
    let upstreamRequestId: string | undefined;
    const runtime = {
      ...mock.runtime,
      executor: {
        execute: (
          _operation: unknown,
          _variables: Record<string, unknown>,
          options?: { readonly requestId?: string },
        ) => {
          upstreamRequestId = options?.requestId;
          return Promise.reject(new Error('private upstream failure'));
        },
      },
    } as unknown as Runtime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'request-id-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: 'connection_check', arguments: {} });
    expect(result.isError).toBe(true);
    expect(upstreamRequestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'internal' },
      meta: { requestId: upstreamRequestId },
    });
    expect(JSON.stringify(result)).not.toContain('private upstream failure');
  });

  it('exposes static capabilities and renders a workflow prompt', async () => {
    const { client, operationNames } = await connect();
    const resource = await client.readResource({ uri: 'newrelic://server/capabilities' });
    const firstContent = resource.contents[0];
    const resourceText =
      firstContent !== undefined && 'text' in firstContent ? firstContent.text : '{}';
    expect(JSON.parse(resourceText)).toMatchObject({
      protocolVersion: '2025-11-25',
    });
    const prompt = await client.getPrompt({
      name: 'incident_triage',
      arguments: { accountId: '42', lookback: '1 hour' },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
    expect(operationNames).toEqual([]);
  });
});

describe('confirmed writes', () => {
  it('does not mutate during dry-run and requires the bound confirmation phrase', async () => {
    const { client, operationNames } = await connect({ NEW_RELIC_ENABLE_WRITES: 'true' });
    const input = { guid: 'ENTITY', tags: [{ key: 'team', values: ['platform'] }] };
    const dryRun = await client.callTool({ name: 'entity_tags_add', arguments: input });
    const preview = dryRun.structuredContent as {
      data?: { confirmationPhrase?: string; dryRun?: boolean };
    };
    expect(preview.data?.dryRun).toBe(true);
    expect(preview.data?.confirmationPhrase).toMatch(/^APPLY entity_tags_add [a-f0-9]{16}$/u);
    expect(operationNames).toEqual(['EntityGet']);

    const rejected = await client.callTool({
      name: 'entity_tags_add',
      arguments: { ...input, dryRun: false, confirmation: 'APPLY wrong' },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' },
    });
    expect(operationNames).toEqual(['EntityGet', 'EntityGet']);

    const applied = await client.callTool({
      name: 'entity_tags_add',
      arguments: {
        ...input,
        dryRun: false,
        confirmation: preview.data?.confirmationPhrase,
      },
    });
    expect(applied.isError).not.toBe(true);
    expect(operationNames.slice(-3)).toEqual(['EntityGet', 'EntityTagsAdd', 'EntityGet']);
  });
});
