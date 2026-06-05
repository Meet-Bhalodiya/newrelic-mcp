import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  NerdGraphClient,
  NerdGraphError,
  Semaphore,
  readBoundedResponse,
  type NerdGraphOperation,
} from '../../src/newrelic/index.js';
import { SERVER_VERSION } from '../../src/version.js';

const operation: NerdGraphOperation<{ accountId: number }, { actor: { value: number } }> = {
  operationName: 'TestQuery',
  kind: 'query',
  document: 'query TestQuery($accountId: Int!) { actor { value } }',
  variablesSchema: z.object({ accountId: z.number().int().positive() }),
  dataSchema: z.object({ actor: z.object({ value: z.number() }) }),
  cacheable: true,
};

const mutationOperation: NerdGraphOperation<
  { value: string },
  { taggingAddTagsToEntity: { errors: { description: string; type: string }[] } }
> = {
  operationName: 'TestMutation',
  kind: 'mutation',
  document:
    'mutation TestMutation($value: String!) { taggingAddTagsToEntity(guid: $value, tags: []) { errors { description type } } }',
  variablesSchema: z.object({ value: z.string() }),
  dataSchema: z.object({
    taggingAddTagsToEntity: z.object({
      errors: z.array(z.object({ description: z.string(), type: z.string() })),
    }),
  }),
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function client(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof NerdGraphClient>[0]> = {},
) {
  return new NerdGraphClient({
    apiKey: 'NRAK-secret',
    endpoint: 'https://api.newrelic.com/graphql',
    region: 'US',
    fetch,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...overrides,
  });
}

describe('NerdGraph client', () => {
  it('sends fixed operations with variables and validates structured data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('api-key')).toBe('NRAK-secret');
      expect(headers.get('user-agent')).toBe(`newrelic-mcp/${SERVER_VERSION}`);
      if (typeof init?.body !== 'string') throw new TypeError('Expected a serialized request body');
      expect(JSON.parse(init.body)).toEqual({
        operationName: 'TestQuery',
        query: operation.document,
        variables: { accountId: 42 },
      });
      return Promise.resolve(jsonResponse({ data: { actor: { value: 7 } } }));
    });
    const result = await client(fetch).execute(
      operation,
      { accountId: 42 },
      { requestId: 'request-1' },
    );
    expect(result.data.actor.value).toBe(7);
    expect(result.meta).toMatchObject({
      requestId: 'request-1',
      retries: 0,
      partial: false,
      region: 'US',
    });
  });

  it('preserves validated partial data with sanitized warnings', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: { actor: { value: 7 } },
          errors: [
            {
              message: 'query account secret-name failed',
              path: ['actor'],
              extensions: { code: 'FORBIDDEN' },
            },
          ],
        }),
      ),
    );
    const stringOperation: NerdGraphOperation<{ name: string }, { actor: { value: number } }> = {
      ...operation,
      variablesSchema: z.object({ name: z.string() }),
    };
    const result = await client(fetch).execute(stringOperation, { name: 'secret-name' });
    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).not.toContain('secret-name');
    expect(result.errors[0]?.code).toBe('FORBIDDEN');
  });

  it('retries reads on 429 but never retries mutations', async () => {
    const readFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { actor: { value: 1 } } }));
    const result = await client(readFetch).execute(operation, { accountId: 42 });
    expect(readFetch).toHaveBeenCalledTimes(2);
    expect(result.meta.retries).toBe(1);

    const mutation = {
      ...operation,
      operationName: 'TestMutation',
      kind: 'mutation' as const,
      document: 'mutation TestMutation($accountId: Int!) { actor { value } }',
    };
    const mutationFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      client(mutationFetch, { allowMutations: true }).execute(mutation, { accountId: 42 }),
    ).rejects.toMatchObject({ code: 'upstream' });
    expect(mutationFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on mutation domain errors without retrying or leaking variables', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            taggingAddTagsToEntity: {
              errors: [{ description: 'Access denied for sensitive-guid', type: 'NOT_AUTHORIZED' }],
            },
          },
        }),
      ),
    );

    await expect(
      client(fetch, { allowMutations: true }).execute(mutationOperation, {
        value: 'sensitive-guid',
      }),
    ).rejects.toMatchObject({
      code: 'authorization',
      issues: [{ message: 'Access denied for [REDACTED]', code: 'NOT_AUTHORIZED' }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts empty mutation error arrays and rejects singular mutation errors', async () => {
    const successFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { taggingAddTagsToEntity: { errors: [] } } })),
    );
    await expect(
      client(successFetch, { allowMutations: true }).execute(mutationOperation, { value: 'guid' }),
    ).resolves.toMatchObject({ data: { taggingAddTagsToEntity: { errors: [] } } });

    const singularErrorOperation: NerdGraphOperation<
      { value: string },
      { notificationDestinationCreate: { error: { details: string; type: string } | null } }
    > = {
      operationName: 'SingularErrorMutation',
      kind: 'mutation',
      document:
        'mutation SingularErrorMutation($value: String!) { notificationDestinationCreate(accountId: 1, destination: { name: $value }) { error { details type } } }',
      variablesSchema: z.object({ value: z.string() }),
      dataSchema: z.object({
        notificationDestinationCreate: z.object({
          error: z.object({ details: z.string(), type: z.string() }).nullable(),
        }),
      }),
    };
    const errorFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            notificationDestinationCreate: {
              error: { details: 'Invalid secret-name', type: 'VALIDATION_ERROR' },
            },
          },
        }),
      ),
    );
    await expect(
      client(errorFetch, { allowMutations: true }).execute(singularErrorOperation, {
        value: 'secret-name',
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      issues: [{ message: 'Invalid [REDACTED]', code: 'VALIDATION_ERROR' }],
    });
    expect(errorFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on partial GraphQL mutation errors because the outcome is uncertain', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: { taggingAddTagsToEntity: { errors: [] } },
          errors: [{ message: 'A downstream field failed', extensions: { code: 'FORBIDDEN' } }],
        }),
      ),
    );
    await expect(
      client(fetch, { allowMutations: true }).execute(mutationOperation, { value: 'guid' }),
    ).rejects.toMatchObject({ code: 'authorization' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries transient read network failures and transient GraphQL failures', async () => {
    const networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockResolvedValueOnce(jsonResponse({ data: { actor: { value: 1 } } }));
    await expect(client(networkFetch).execute(operation, { accountId: 42 })).resolves.toMatchObject(
      {
        data: { actor: { value: 1 } },
        meta: { retries: 1 },
      },
    );

    const graphqlFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: null,
          errors: [{ message: 'temporarily unavailable', extensions: { code: 'THROTTLED' } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { actor: { value: 2 } } }));
    await expect(client(graphqlFetch).execute(operation, { accountId: 42 })).resolves.toMatchObject(
      {
        data: { actor: { value: 2 } },
        meta: { retries: 1 },
      },
    );
  });

  it('enforces account allowlists before sending any request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      client(fetch, { accountPolicy: { accountAllowlist: [42] } }).execute(operation, {
        accountId: 43,
      }),
    ).rejects.toThrow(/account policy/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds response bodies and validates schema drift', async () => {
    await expect(
      readBoundedResponse(
        new Response('a'.repeat(32), { headers: { 'content-length': '32' } }),
        16,
      ),
    ).rejects.toMatchObject({ code: 'response-too-large' });
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { actor: { value: 'wrong' } } })),
    );
    await expect(client(fetch).execute(operation, { accountId: 42 })).rejects.toMatchObject({
      code: 'upstream-schema',
    });
  });

  it('preserves cancellation and timeout classification while reading response bodies', async () => {
    const neverEndingResponse = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Intentionally leave the body read pending until its signal is cancelled.
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const directController = new AbortController();
    const directRead = readBoundedResponse(neverEndingResponse(), 1024, directController.signal);
    directController.abort();
    await expect(directRead).rejects.toMatchObject({ code: 'cancelled' });

    const callerController = new AbortController();
    const callerFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(neverEndingResponse()),
    );
    const callerRequest = client(callerFetch).execute(
      operation,
      { accountId: 42 },
      { signal: callerController.signal },
    );
    callerController.abort();
    await expect(callerRequest).rejects.toMatchObject({ code: 'cancelled' });

    const timeoutFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(neverEndingResponse()),
    );
    await expect(
      client(timeoutFetch, { timeoutMs: 100 }).execute(operation, { accountId: 42 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('uses a bounded TTL cache only for complete reads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { actor: { value: 1 } } })),
    );
    const cachedClient = client(fetch, { cacheTtlMs: 10_000, cacheMaxEntries: 2 });
    await cachedClient.execute(operation, { accountId: 42 });
    const second = await cachedClient.execute(operation, { accountId: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.meta.cacheHit).toBe(true);
  });

  it('does not cache data-bearing reads unless the fixed operation explicitly opts in', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { actor: { value: 1 } } })),
    );
    const cachedClient = client(fetch, { cacheTtlMs: 10_000, cacheMaxEntries: 2 });
    const sensitiveRead = { ...operation, cacheable: false };
    await cachedClient.execute(sensitiveRead, { accountId: 42 });
    await cachedClient.execute(sensitiveRead, { accountId: 42 });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never caches complex NRQL reads or asynchronous progress polling', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { actor: { value: 1 } } })),
    );
    const cachedClient = client(fetch, { cacheTtlMs: 10_000, cacheMaxEntries: 2 });
    const complex = { ...operation, complexNrql: true };
    await cachedClient.execute(complex, { accountId: 42 });
    await cachedClient.execute(complex, { accountId: 42 });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached reads after a successful mutation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({ data: { actor: { value: 1 } } })));
    const cachedClient = client(fetch, {
      allowMutations: true,
      cacheTtlMs: 10_000,
      cacheMaxEntries: 2,
    });
    await cachedClient.execute(operation, { accountId: 42 });
    const mutation = {
      ...operation,
      operationName: 'TestMutation',
      kind: 'mutation' as const,
      document: 'mutation TestMutation($accountId: Int!) { actor { value } }',
    };
    await cachedClient.execute(mutation, { accountId: 42 });
    await cachedClient.execute(operation, { accountId: 42 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('invalidates cached reads before a mutation with an uncertain outcome', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { actor: { value: 1 } } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { actor: { value: 2 } } }));
    const cachedClient = client(fetch, {
      allowMutations: true,
      cacheTtlMs: 10_000,
      cacheMaxEntries: 2,
    });
    await cachedClient.execute(operation, { accountId: 42 });
    const mutation = {
      ...operation,
      operationName: 'TestMutation',
      kind: 'mutation' as const,
      document: 'mutation TestMutation($accountId: Int!) { actor { value } }',
    };
    await expect(cachedClient.execute(mutation, { accountId: 42 })).rejects.toMatchObject({
      code: 'upstream',
    });
    await expect(cachedClient.execute(operation, { accountId: 42 })).resolves.toMatchObject({
      data: { actor: { value: 2 } },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('validates outbound request identifiers and experimental headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      client(fetch).execute(operation, { accountId: 42 }, { requestId: 'bad\r\nid' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      client(fetch).execute(
        { ...operation, experimentalHeader: 'AiIssues\r\nInjected: true' },
        { accountId: 42 },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never exceeds total or complex NRQL concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const releases: (() => void)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return jsonResponse({ data: { actor: { value: 1 } } });
    });
    const limited = client(fetch, { concurrency: 3, nrqlConcurrency: 2 });
    const complex = { ...operation, complexNrql: true };
    const calls = Array.from({ length: 5 }, (_, index) =>
      limited.execute(complex, { accountId: index + 1 }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    while (releases.length > 0 || fetch.mock.calls.length < 5) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releases.splice(0).forEach((release) => release());
    await Promise.all(calls);
    expect(maximum).toBe(2);
  });
});

describe('Semaphore', () => {
  it('removes aborted waiters without leaking permits', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(NerdGraphError);
    release();
    expect(semaphore.stats).toEqual({ active: 0, pending: 0, limit: 1 });
  });

  it('rejects overload instead of retaining an unbounded queue', async () => {
    const semaphore = new Semaphore(1, 1);
    const release = await semaphore.acquire();
    const waiting = semaphore.acquire();

    await expect(semaphore.acquire()).rejects.toMatchObject({ code: 'rate-limited' });
    release();
    const releaseWaiting = await waiting;
    releaseWaiting();
    expect(semaphore.stats).toEqual({ active: 0, pending: 0, limit: 1 });
  });
});
