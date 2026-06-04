import type { SafeUpstreamError } from '../security/redaction.js';

export type NerdGraphErrorCode =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not-found'
  | 'rate-limited'
  | 'timeout'
  | 'upstream-schema'
  | 'unsupported'
  | 'upstream'
  | 'response-too-large'
  | 'cancelled'
  | 'write-disabled';

export class NerdGraphError extends Error {
  readonly code: NerdGraphErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly issues: readonly SafeUpstreamError[];

  constructor(
    code: NerdGraphErrorCode,
    message: string,
    options: {
      readonly status?: number | undefined;
      readonly retryAfterMs?: number | undefined;
      readonly issues?: readonly SafeUpstreamError[] | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NerdGraphError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.issues = options.issues ?? [];
  }
}

export function errorCodeForStatus(status: number): NerdGraphErrorCode {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'response-too-large';
  if (status === 429) return 'rate-limited';
  return 'upstream';
}

export function errorCodeForGraphQlIssues(
  issues: readonly SafeUpstreamError[],
): NerdGraphErrorCode {
  const codes = new Set(
    issues
      .map(({ code }) => code?.toUpperCase())
      .filter((code): code is string => code !== undefined),
  );
  if ([...codes].some((code) => ['UNAUTHENTICATED', 'AUTHENTICATION_ERROR'].includes(code))) {
    return 'authentication';
  }
  if (
    [...codes].some((code) => ['FORBIDDEN', 'NOT_AUTHORIZED', 'PERMISSION_DENIED'].includes(code))
  ) {
    return 'authorization';
  }
  if ([...codes].some((code) => ['NOT_FOUND', 'ENTITY_NOT_FOUND'].includes(code))) {
    return 'not-found';
  }
  if ([...codes].some((code) => ['RATE_LIMITED', 'THROTTLED'].includes(code))) {
    return 'rate-limited';
  }
  if ([...codes].some((code) => ['TIMEOUT', 'DEADLINE_EXCEEDED'].includes(code))) {
    return 'timeout';
  }
  if (
    [...codes].some((code) =>
      ['FEATURE_NOT_AVAILABLE', 'NOT_ENTITLED', 'UNSUPPORTED', 'UNSUPPORTED_OPERATION'].includes(
        code,
      ),
    )
  ) {
    return 'unsupported';
  }
  if (
    [...codes].some((code) =>
      ['BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED', 'VALIDATION_ERROR'].includes(code),
    )
  ) {
    return 'validation';
  }
  return 'upstream';
}
