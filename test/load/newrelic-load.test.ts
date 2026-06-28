import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { NerdGraphClient, type NerdGraphOperation } from '../../src/newrelic/index.js';
import { createHttpApp } from '../../src/http.js';
import { createMcpServer } from '../../src/server.js';
import { createMockRuntime } from '../helpers/runtime.js';

const operation: NerdGraphOperation<{ accountId: number }, { actor: { value: number } }> = {
  operationName: 'LoadQuery',
  kind: 'query',
  document: 'query LoadQuery($accountId: Int!) { actor { value } }',
  variablesSchema: z.object({ accountId: z.number().int().positive() }),
  dataSchema: z.object({ actor: z.object({ value: z.number() }) }),
};

function response(): Response {
  return new Response('{"data":{"actor":{"value":1}}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetch: typeof globalThis.fetch): NerdGraphClient {
  return new NerdGraphClient({
    apiKey: 'NRAK-load-test',
    endpoint: 'https://api.newrelic.com/graphql',
    region: 'US',
    concurrency: 20,
    nrqlConcurrency: 5,
    cacheTtlMs: 0,
    cacheMaxEntries: 0,
    maxReadRetries: 0,
    fetch,
  });
}

describe('mocked NerdGraph load limits', () => {
  it('keeps the complete authenticated HTTP MCP proxy bounded over 10,000 calls', async () => {
    let active = 0;
    let maximumActive = 0;
    const bearerToken = 'load-test-bearer-token'.padEnd(32, '-');
    const mock = createMockRuntime(
      {
        MCP_AUTH_MODE: 'bearer',
        MCP_BEARER_TOKEN: bearerToken,
        NEW_RELIC_CONCURRENCY: '20',
        NEW_RELIC_NRQL_CONCURRENCY: '5',
        NEW_RELIC_CACHE_TTL_MS: '0',
        LOG_LEVEL: 'silent',
      },
      async (operationName) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (operationName !== 'ConnectionCheck') throw new Error('Unexpected load operation');
          return {
            actor: {
              user: { id: 'load-user' },
              accounts: [{ id: 42, name: 'Load account' }],
            },
          };
        } finally {
          active -= 1;
        }
      },
    );
    const app = await createHttpApp(mock.runtime, (requestContext) =>
      createMcpServer(mock.runtime, requestContext),
    );
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    let requestId = 0;
    const call = async (): Promise<number> => {
      const started = performance.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: (requestId += 1),
          method: 'tools/call',
          params: { name: 'connection_check', arguments: {} },
        }),
      });
      const body = (await response.json()) as {
        result?: { structuredContent?: { ok?: unknown }; content?: unknown[] };
      };
      expect(response.status).toBe(200);
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.content).toHaveLength(1);
      return performance.now() - started;
    };

    // Warm the HTTP agent, SDK registrations, and JIT before measuring proxy overhead.
    await Promise.all(Array.from({ length: 40 }, async () => await call()));
    (globalThis as { gc?: () => void }).gc?.();
    const baselineHeap = process.memoryUsage().heapUsed;
    let maximumHeap = baselineHeap;
    const checkpointHeaps: number[] = [];
    const proxyDurations: number[] = [];

    try {
      // Twenty-wide batches exercise the configured upstream semaphore without retaining
      // thousands of request promises in the test runner itself.
      for (let batch = 0; batch < 500; batch += 1) {
        await Promise.all(Array.from({ length: 20 }, async () => await call()));
        if ((batch + 1) % 50 === 0) {
          (globalThis as { gc?: () => void }).gc?.();
          const heap = process.memoryUsage().heapUsed;
          checkpointHeaps.push(heap);
          maximumHeap = Math.max(maximumHeap, heap);
        }
      }
      // Measure proxy service time without client-side queueing or twenty requests contending
      // for one test-runner CPU. The 10,000-call phase above separately proves load stability.
      for (let sample = 0; sample < 250; sample += 1) proxyDurations.push(await call());
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    proxyDurations.sort((left, right) => left - right);
    const p95 = proxyDurations[Math.ceil(proxyDurations.length * 0.95) - 1];
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(100);
    expect(maximumActive).toBeLessThanOrEqual(20);
    expect(mock.runtime.client.stats.requests).toMatchObject({ active: 0, pending: 0, limit: 20 });
    expect(mock.runtime.client.stats.nrql).toMatchObject({ active: 0, pending: 0, limit: 5 });
    if ((globalThis as { gc?: () => void }).gc !== undefined) {
      // The dedicated `npm run test:load` command exposes GC so this is a retained-heap
      // assertion, not a transient allocation-watermark assertion.
      expect(maximumHeap - baselineHeap).toBeLessThan(192 * 1024 * 1024);
      expect(checkpointHeaps.at(-1)! - checkpointHeaps[0]!).toBeLessThan(64 * 1024 * 1024);
    }
    expect(mock.operationNames).toHaveLength(10_290);
  }, 120_000);

  it('never permits more than five complex NRQL calls upstream', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetch: typeof globalThis.fetch = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return response();
    };
    const loaded = client(fetch);
    const complex = {
      ...operation,
      operationName: 'ComplexLoadQuery',
      document: 'query ComplexLoadQuery($accountId: Int!) { actor { value } }',
      complexNrql: true,
    };
    await Promise.all(
      Array.from({ length: 250 }, (_, index) => loaded.execute(complex, { accountId: index + 1 })),
    );
    expect(maximumActive).toBeLessThanOrEqual(5);
  }, 30_000);

  it('keeps direct NerdGraph client overhead below the HTTP proxy budget', async () => {
    const loaded = client(() => Promise.resolve(response()));
    const durations: number[] = [];
    for (let index = 0; index < 250; index += 1) {
      const started = performance.now();
      await loaded.execute(operation, { accountId: index + 1 });
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(100);
  }, 30_000);
});
