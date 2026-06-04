import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { SERVER_VERSION } from '../version.js';
import type { NewRelicRegion } from '../config/endpoints.js';
import type { AccountPolicy } from '../security/account.js';
import { assertAccountVariablesAllowed } from '../security/account.js';
import {
  redactText,
  sanitizeUpstreamError,
  type SafeUpstreamError,
} from '../security/redaction.js';
import { TtlCache } from './cache.js';
import { errorCodeForGraphQlIssues, errorCodeForStatus, NerdGraphError } from './errors.js';
import { readBoundedResponse } from './response.js';
import { Semaphore, type SemaphoreStats } from './semaphore.js';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_GRAPHQL_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'RATE_LIMITED',
  'THROTTLED',
  'TIMEOUT',
  'SERVICE_UNAVAILABLE',
]);

const graphqlErrorSchema = z
  .object({
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    locations: z.array(z.object({ line: z.number(), column: z.number() })).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const graphqlEnvelopeSchema = z
  .object({
    data: z.unknown().nullable().optional(),
    errors: z.array(graphqlErrorSchema).optional(),
  })
  .loose();

export type NerdGraphOperation<TVariables, TData> = {
  readonly operationName: string;
  readonly document: string;
  readonly kind: 'query' | 'mutation';
  readonly variablesSchema: z.ZodType<TVariables>;
  readonly dataSchema: z.ZodType<TData>;
  readonly complexNrql?: boolean | undefined;
  readonly cacheable?: boolean | undefined;
  readonly experimentalHeader?: string | undefined;
};

export type NerdGraphExecuteOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly requestId?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly nrqlTimeoutMs?: number | undefined;
  readonly bypassCache?: boolean | undefined;
};

export type NerdGraphResultMeta = {
  readonly requestId: string;
  readonly durationMs: number;
  readonly region: NewRelicRegion;
  readonly status: number;
  readonly retries: number;
  readonly partial: boolean;
  readonly truncated: false;
  readonly cacheHit: boolean;
};

export type NerdGraphResult<TData> = {
  readonly data: TData;
  readonly errors: readonly SafeUpstreamError[];
  readonly partial: boolean;
  readonly meta: NerdGraphResultMeta;
};

export type NerdGraphClientLike = {
  execute<TVariables, TData>(
    operation: NerdGraphOperation<TVariables, TData>,
    variables: unknown,
    options?: NerdGraphExecuteOptions,
  ): Promise<NerdGraphResult<TData>>;
};

export type NerdGraphClientOptions = {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly region: NewRelicRegion;
  readonly concurrency?: number | undefined;
  readonly nrqlConcurrency?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly nrqlTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxReadRetries?: number | undefined;
  readonly allowMutations?: boolean | undefined;
  readonly accountPolicy?: AccountPolicy | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly cacheMaxEntries?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly random?: (() => number) | undefined;
  readonly sleep?: ((milliseconds: number, signal: AbortSignal) => Promise<void>) | undefined;
};

type AttemptResult<TData> = {
  readonly result: NerdGraphResult<TData>;
  readonly retryableGraphql: boolean;
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal.reason));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Request was aborted', { cause: reason });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.min(timestamp - Date.now(), 60_000));
}

function retryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const ceiling = Math.min(250 * 2 ** attempt, 5_000);
  return Math.floor(ceiling * (0.5 + random() * 0.5));
}

function operationDocumentIsValid(operation: NerdGraphOperation<unknown, unknown>): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(operation.operationName)) return false;
  if (Buffer.byteLength(operation.document, 'utf8') > 128 * 1024) return false;
  const definitions = [
    ...operation.document.matchAll(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/g),
  ];
  const definition = definitions[0];
  return (
    definitions.length === 1 &&
    definition?.[1] === operation.kind &&
    definition[2] === operation.operationName &&
    !/\bsubscription\b/.test(operation.document)
  );
}

function variableStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 3) output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) variableStrings(entry, output);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) variableStrings(entry, output);
  }
  return output.sort((left, right) => right.length - left.length);
}

function safeIssues(errors: readonly unknown[], variables: unknown): SafeUpstreamError[] {
  const sensitiveValues = variableStrings(variables);
  return errors.map((error) => {
    const sanitized = sanitizeUpstreamError(error);
    let message = sanitized.message;
    for (const value of sensitiveValues) message = message.replaceAll(value, '[REDACTED]');
    return { ...sanitized, message: redactText(message, 512) };
  });
}

function graphQlErrorsRetryable(errors: readonly SafeUpstreamError[]): boolean {
  return (
    errors.length > 0 &&
    errors.every(
      (error) => error.code !== undefined && RETRYABLE_GRAPHQL_CODES.has(error.code.toUpperCase()),
    )
  );
}

function mutationDomainIssues(value: unknown, variables: unknown): SafeUpstreamError[] {
  const issues: unknown[] = [];
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === 'errors' && Array.isArray(child)) {
        for (const issue of child as unknown[]) issues.push(issue);
        continue;
      }
      if (key === 'error' && child !== null && child !== undefined) {
        issues.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(value);
  return safeIssues(issues, variables);
}

function cacheKey(operationName: string, document: string, serializedVariables: string): string {
  return createHash('sha256')
    .update(operationName)
    .update('\0')
    .update(document)
    .update('\0')
    .update(serializedVariables)
    .digest('base64url');
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class NerdGraphClient implements NerdGraphClientLike {
  readonly endpoint: URL;
  readonly region: NewRelicRegion;
  readonly concurrency: Semaphore;
  readonly nrqlConcurrency: Semaphore;
  readonly cache: TtlCache<NerdGraphResult<unknown>>;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #nrqlTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRequestBytes: number;
  readonly #maxReadRetries: number;
  readonly #allowMutations: boolean;
  readonly #accountPolicy: AccountPolicy | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: NerdGraphClientOptions) {
    if (options.apiKey.trim() === '') throw new TypeError('New Relic API key is required');
    this.endpoint = new URL(options.endpoint);
    if (
      this.endpoint.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '::1'].includes(this.endpoint.hostname)
    ) {
      throw new TypeError('NerdGraph endpoint must use HTTPS');
    }
    this.region = options.region;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 'timeoutMs', 100, 600_000);
    this.#nrqlTimeoutMs = boundedInteger(
      options.nrqlTimeoutMs ?? this.#timeoutMs,
      'nrqlTimeoutMs',
      100,
      600_000,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 1024 * 1024,
      'maxResponseBytes',
      1024,
      16 * 1024 * 1024,
    );
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes ?? 1024 * 1024,
      'maxRequestBytes',
      1024,
      16 * 1024 * 1024,
    );
    this.#maxReadRetries = boundedInteger(options.maxReadRetries ?? 3, 'maxReadRetries', 0, 3);
    this.#allowMutations = options.allowMutations ?? false;
    this.#accountPolicy = options.accountPolicy;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? defaultSleep;
    this.concurrency = new Semaphore(options.concurrency ?? 20);
    this.nrqlConcurrency = new Semaphore(options.nrqlConcurrency ?? 5);
    this.cache = new TtlCache(
      boundedInteger(options.cacheTtlMs ?? 0, 'cacheTtlMs', 0, 3_600_000),
      boundedInteger(options.cacheMaxEntries ?? 0, 'cacheMaxEntries', 0, 10_000),
    );
  }

  get stats(): {
    readonly requests: SemaphoreStats;
    readonly nrql: SemaphoreStats;
    readonly cacheEntries: number;
  } {
    return {
      requests: this.concurrency.stats,
      nrql: this.nrqlConcurrency.stats,
      cacheEntries: this.cache.size,
    };
  }

  async execute<TVariables, TData>(
    operation: NerdGraphOperation<TVariables, TData>,
    variables: unknown,
    options: NerdGraphExecuteOptions = {},
  ): Promise<NerdGraphResult<TData>> {
    if (!operationDocumentIsValid(operation)) {
      throw new NerdGraphError('validation', 'Invalid fixed GraphQL operation definition');
    }
    if (operation.kind === 'mutation' && !this.#allowMutations) {
      throw new NerdGraphError('write-disabled', 'New Relic mutations are disabled');
    }
    if (
      operation.experimentalHeader !== undefined &&
      !/^[A-Za-z0-9,_-]{1,128}$/u.test(operation.experimentalHeader)
    ) {
      throw new NerdGraphError('validation', 'Invalid experimental API opt-in header');
    }
    const parsedVariables = operation.variablesSchema.safeParse(variables);
    if (!parsedVariables.success) {
      throw new NerdGraphError(
        'validation',
        'GraphQL variables did not match the operation schema',
        {
          cause: parsedVariables.error,
        },
      );
    }
    if (this.#accountPolicy !== undefined) {
      assertAccountVariablesAllowed(parsedVariables.data, this.#accountPolicy);
    }
    let serializedVariables: string;
    let requestBody: string;
    try {
      serializedVariables = JSON.stringify(parsedVariables.data);
      requestBody = JSON.stringify({
        query: operation.document,
        operationName: operation.operationName,
        variables: parsedVariables.data,
      });
    } catch (error) {
      throw new NerdGraphError('validation', 'GraphQL variables must be JSON serializable', {
        cause: error,
      });
    }
    if (Buffer.byteLength(requestBody, 'utf8') > this.#maxRequestBytes) {
      throw new NerdGraphError('validation', 'GraphQL request exceeded the configured size limit');
    }
    const requestId = options.requestId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      throw new NerdGraphError('validation', 'Request ID contains unsupported characters');
    }
    const started = performance.now();
    const key =
      operation.kind === 'query' && operation.cacheable === true && operation.complexNrql !== true
        ? cacheKey(operation.operationName, operation.document, serializedVariables)
        : undefined;
    if (key !== undefined && options.bypassCache !== true) {
      const cached = this.cache.get(key) as NerdGraphResult<TData> | undefined;
      if (cached !== undefined) {
        return {
          ...structuredClone(cached),
          meta: {
            ...cached.meta,
            requestId,
            durationMs: performance.now() - started,
            cacheHit: true,
          },
        };
      }
    }
    // A mutation may have committed even when its response is lost or contains domain errors.
    // Invalidate before sending so an uncertain outcome can never leave stale metadata cached.
    if (operation.kind === 'mutation') this.cache.clear();

    const timeoutController = new AbortController();
    const effectiveTimeoutMs = boundedInteger(
      options.timeoutMs ?? (operation.complexNrql === true ? this.#nrqlTimeoutMs : this.#timeoutMs),
      'timeoutMs',
      100,
      600_000,
    );
    const timer = setTimeout(
      () => timeoutController.abort(new Error('NerdGraph operation timed out')),
      effectiveTimeoutMs,
    );
    timer.unref();
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);
    try {
      const maximumAttempts = operation.kind === 'query' ? this.#maxReadRetries + 1 : 1;
      let lastError: NerdGraphError | undefined;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        if (signal.aborted)
          throw this.#abortError(options.signal, timeoutController, signal.reason);
        try {
          const attempted = await this.#withConcurrency(
            () =>
              this.#attempt(
                operation,
                parsedVariables.data,
                requestBody,
                requestId,
                started,
                attempt,
                signal,
              ),
            operation.complexNrql === true,
            signal,
          );
          if (attempted.retryableGraphql && attempt + 1 < maximumAttempts) {
            await this.#backoff(
              retryDelay(attempt, undefined, this.#random),
              signal,
              options.signal,
              timeoutController,
            );
            continue;
          }
          if (operation.kind === 'query' && !attempted.result.partial && key !== undefined) {
            this.cache.set(key, structuredClone(attempted.result));
          }
          return attempted.result;
        } catch (error) {
          const normalized = this.#normalizeError(error, options.signal, timeoutController);
          lastError = normalized;
          if (
            operation.kind !== 'query' ||
            attempt + 1 >= maximumAttempts ||
            !this.#isRetryable(normalized)
          ) {
            throw normalized;
          }
          await this.#backoff(
            retryDelay(attempt, normalized.retryAfterMs, this.#random),
            signal,
            options.signal,
            timeoutController,
          );
        }
      }
      throw lastError ?? new NerdGraphError('upstream', 'New Relic request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async #withConcurrency<T>(
    task: () => Promise<T>,
    complexNrql: boolean,
    signal: AbortSignal,
  ): Promise<T> {
    if (complexNrql) {
      return this.nrqlConcurrency.run(() => this.concurrency.run(task, signal), signal);
    }
    return this.concurrency.run(task, signal);
  }

  async #attempt<TVariables, TData>(
    operation: NerdGraphOperation<TVariables, TData>,
    variables: TVariables,
    requestBody: string,
    requestId: string,
    started: number,
    retries: number,
    signal: AbortSignal,
  ): Promise<AttemptResult<TData>> {
    const response = await this.#fetch(this.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': this.#apiKey,
        'user-agent': `newrelic-mcp/${SERVER_VERSION}`,
        'x-request-id': requestId,
        ...(operation.experimentalHeader === undefined
          ? {}
          : { 'nerd-graph-unsafe-experimental-opt-in': operation.experimentalHeader }),
      },
      body: requestBody,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new NerdGraphError(
        errorCodeForStatus(response.status),
        `New Relic request failed with HTTP ${response.status}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        },
      );
    }
    const text = await readBoundedResponse(response, this.#maxResponseBytes, signal);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new NerdGraphError('upstream-schema', 'New Relic returned invalid JSON', {
        status: response.status,
        cause: error,
      });
    }
    const envelopeResult = graphqlEnvelopeSchema.safeParse(json);
    if (!envelopeResult.success) {
      throw new NerdGraphError(
        'upstream-schema',
        'New Relic response did not match the GraphQL envelope',
        {
          status: response.status,
          cause: envelopeResult.error,
        },
      );
    }
    const rawErrors = envelopeResult.data.errors ?? [];
    const issues = safeIssues(rawErrors, variables);
    const partial = issues.length > 0;
    if (envelopeResult.data.data === undefined || envelopeResult.data.data === null) {
      throw new NerdGraphError(
        errorCodeForGraphQlIssues(issues),
        'New Relic GraphQL request failed',
        {
          status: response.status,
          issues,
        },
      );
    }
    const dataResult = operation.dataSchema.safeParse(envelopeResult.data.data);
    if (!dataResult.success) {
      throw new NerdGraphError(
        'upstream-schema',
        'New Relic data did not match the expected schema',
        {
          status: response.status,
          issues,
          cause: dataResult.error,
        },
      );
    }
    if (operation.kind === 'mutation' && issues.length > 0) {
      throw new NerdGraphError(
        errorCodeForGraphQlIssues(issues),
        'New Relic mutation returned partial GraphQL errors; its outcome may be uncertain',
        { status: response.status, issues },
      );
    }
    if (operation.kind === 'mutation') {
      const domainIssues = mutationDomainIssues(dataResult.data, variables);
      if (domainIssues.length > 0) {
        throw new NerdGraphError(
          errorCodeForGraphQlIssues(domainIssues),
          'New Relic mutation reported an error',
          { status: response.status, issues: domainIssues },
        );
      }
    }
    return {
      result: {
        data: dataResult.data,
        errors: issues,
        partial,
        meta: {
          requestId,
          durationMs: performance.now() - started,
          region: this.region,
          status: response.status,
          retries,
          partial,
          truncated: false,
          cacheHit: false,
        },
      },
      retryableGraphql: graphQlErrorsRetryable(issues),
    };
  }

  #normalizeError(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    timeoutController: AbortController,
  ): NerdGraphError {
    if (
      error instanceof NerdGraphError &&
      error.code === 'cancelled' &&
      callerSignal?.aborted !== true &&
      timeoutController.signal.aborted
    ) {
      return new NerdGraphError('timeout', 'New Relic request timed out', { cause: error });
    }
    if (error instanceof NerdGraphError) return error;
    if (callerSignal?.aborted === true)
      return new NerdGraphError('cancelled', 'Request was cancelled', { cause: error });
    if (timeoutController.signal.aborted)
      return new NerdGraphError('timeout', 'New Relic request timed out', { cause: error });
    return new NerdGraphError('upstream', 'New Relic request failed', { cause: error });
  }

  #abortError(
    callerSignal: AbortSignal | undefined,
    timeoutController: AbortController,
    cause: unknown,
  ): NerdGraphError {
    return callerSignal?.aborted === true
      ? new NerdGraphError('cancelled', 'Request was cancelled', { cause })
      : timeoutController.signal.aborted
        ? new NerdGraphError('timeout', 'New Relic request timed out', { cause })
        : new NerdGraphError('cancelled', 'Request was cancelled', { cause });
  }

  #isRetryable(error: NerdGraphError): boolean {
    return (
      error.code === 'rate-limited' ||
      error.code === 'timeout' ||
      (error.code === 'upstream' &&
        (error.status === undefined ||
          RETRYABLE_STATUSES.has(error.status) ||
          graphQlErrorsRetryable(error.issues)))
    );
  }

  async #backoff(
    milliseconds: number,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutController: AbortController,
  ): Promise<void> {
    try {
      await this.#sleep(milliseconds, signal);
    } catch (error) {
      throw this.#normalizeError(error, callerSignal, timeoutController);
    }
  }
}
