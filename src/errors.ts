export const errorCodes = [
  'validation',
  'authentication',
  'authorization',
  'not_found',
  'rate_limited',
  'timeout',
  'upstream_schema',
  'upstream',
  'unsupported',
  'write_disabled',
  'destructive_disabled',
  'admin_disabled',
  'confirmation_required',
  'response_too_large',
  'internal',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type PublicError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
};

export class NewRelicMcpError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | undefined;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NewRelicMcpError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  public toPublic(): PublicError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toMcpError(error: unknown): NewRelicMcpError {
  if (error instanceof NewRelicMcpError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new NewRelicMcpError('timeout', 'The request was cancelled or exceeded its deadline.', {
      cause: error,
      retryable: true,
    });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new NewRelicMcpError('timeout', 'The request was cancelled or exceeded its deadline.', {
      cause: error,
      retryable: true,
    });
  }
  return new NewRelicMcpError('internal', 'An internal error prevented the operation.', {
    cause: error,
  });
}
