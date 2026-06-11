import type { NerdGraphClient } from './newrelic/client.js';
import type {
  NerdGraphExecutionResult,
  NerdGraphOperation,
  NerdGraphOperationExecutor,
} from './operations/index.js';
import type { RuntimeObservability } from './observability.js';
import { withSpan } from './tracing.js';

export class InstrumentedOperationExecutor implements NerdGraphOperationExecutor {
  readonly #client: NerdGraphClient;
  readonly #observability: RuntimeObservability;
  readonly #tracingEnabled: boolean;

  public constructor(
    client: NerdGraphClient,
    observability: RuntimeObservability,
    tracingEnabled = false,
  ) {
    this.#client = client;
    this.#observability = observability;
    this.#tracingEnabled = tracingEnabled;
  }

  public async execute(
    operation: NerdGraphOperation,
    variables: Record<string, unknown>,
    options: {
      readonly signal?: AbortSignal;
      readonly bypassCache?: boolean;
      readonly requestId?: string;
    } = {},
  ): Promise<NerdGraphExecutionResult> {
    const startedAt = performance.now();
    let status = 'error';
    try {
      return await withSpan(
        'newrelic.nerdgraph',
        {
          'newrelic.operation.name': operation.name,
          'newrelic.operation.kind': operation.kind,
          'server.address': this.#client.endpoint.hostname,
        },
        async () => {
          const result = await this.#client.execute(
            {
              operationName: operation.name,
              document: operation.document,
              kind: operation.kind,
              variablesSchema: operation.variablesSchema,
              dataSchema: operation.responseSchema,
              ...(operation.complexNrql === undefined
                ? {}
                : { complexNrql: operation.complexNrql }),
              ...(operation.cacheable === undefined ? {} : { cacheable: operation.cacheable }),
              ...(operation.experimentalHeader === undefined
                ? {}
                : { experimentalHeader: operation.experimentalHeader }),
            },
            variables,
            {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              ...(options.bypassCache === undefined ? {} : { bypassCache: options.bypassCache }),
              ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
            },
          );
          status = `${Math.floor(result.meta.status / 100)}xx`;
          if (
            operation.kind === 'query' &&
            operation.cacheable === true &&
            !operation.complexNrql
          ) {
            this.#observability.cache.inc({ result: result.meta.cacheHit ? 'hit' : 'miss' });
          }
          if (result.meta.retries > 0) {
            this.#observability.retries.inc({ operation: operation.name }, result.meta.retries);
          }
          const pagination = findPagination(result.data);
          return {
            data: result.data,
            partial: result.partial,
            truncated: result.meta.truncated,
            warnings: result.errors.map((error) => error.message),
            ...(pagination === undefined ? {} : { pagination }),
          };
        },
        this.#tracingEnabled,
      );
    } catch (error) {
      if (isRateLimit(error)) {
        status = '429';
        this.#observability.rateLimits.inc({ source: 'nerdgraph' });
      }
      throw error;
    } finally {
      this.#observability.upstreamCalls.inc({ operation: operation.name, status });
      this.#observability.upstreamDuration.observe(
        { operation: operation.name, status },
        (performance.now() - startedAt) / 1000,
      );
      const stats = this.#client.stats;
      this.#observability.queueDepth.set({ queue: 'nerdgraph' }, stats.requests.pending);
      this.#observability.queueDepth.set({ queue: 'nrql' }, stats.nrql.pending);
    }
  }
}

function findPagination(
  value: unknown,
): { nextCursor?: string | null; totalCount?: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findPagination(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const hasCursor = typeof record.nextCursor === 'string' || record.nextCursor === null;
  const hasCount = typeof record.totalCount === 'number' && Number.isFinite(record.totalCount);
  if (hasCursor || hasCount) {
    return {
      ...(hasCursor ? { nextCursor: record.nextCursor as string | null } : {}),
      ...(hasCount ? { totalCount: record.totalCount as number } : {}),
    };
  }
  for (const child of Object.values(record)) {
    const found = findPagination(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRateLimit(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'rate-limited'
  );
}
