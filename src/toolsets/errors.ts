export type ToolErrorCode =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_schema'
  | 'unsupported'
  | 'write_disabled'
  | 'confirmation_required';

export class CapabilityError extends Error {
  readonly code: ToolErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ToolErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

/** Marks a failure raised while the upstream mutation itself was in flight. */
export class MutationOutcomeError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('A New Relic mutation failed while in flight');
    this.name = 'MutationOutcomeError';
    this.cause = cause;
  }
}
