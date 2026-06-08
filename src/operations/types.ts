import type { ZodType } from 'zod';

/** A fixed NerdGraph document. Tool arguments never supply GraphQL documents. */
export interface NerdGraphOperation<
  Variables extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Canonical name used by the NerdGraph client. */
  readonly operationName: string;
  /** Compatibility alias used by catalog/reporting code. */
  readonly name: string;
  readonly kind: 'query' | 'mutation';
  readonly document: string;
  readonly variablesSchema: ZodType<Variables>;
  /** Canonical post-GraphQL data validator used by the NerdGraph client. */
  readonly dataSchema: ZodType<unknown>;
  /** Compatibility alias used by catalog/reporting code. */
  readonly responseSchema: ZodType<unknown>;
  readonly sourceUrl: string;
  readonly experimentalHeader?: string;
  readonly complexNrql?: boolean;
  /** Explicit opt-in for bounded in-memory caching of non-sensitive metadata only. */
  readonly cacheable?: boolean;
}

export interface NerdGraphExecutionResult {
  readonly data: unknown;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }[];
  readonly partial?: boolean;
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
  readonly pagination?: {
    readonly nextCursor?: string | null;
    readonly totalCount?: number;
  };
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Kept deliberately small so the capability layer does not depend on a
 * transport or a particular HTTP implementation.
 */
export interface NerdGraphOperationExecutor {
  execute(
    operation: NerdGraphOperation,
    variables: Record<string, unknown>,
    options?: {
      readonly signal?: AbortSignal;
      readonly bypassCache?: boolean;
      readonly requestId?: string;
    },
  ): Promise<NerdGraphExecutionResult>;
}

export function defineOperation<Variables extends Record<string, unknown>>(
  operation: NerdGraphOperation<Variables>,
): NerdGraphOperation<Variables> {
  const trimmed = operation.document.trim();
  const expected = operation.kind === 'mutation' ? /^mutation\b/u : /^query\b/u;
  if (!expected.test(trimmed)) {
    throw new TypeError(`${operation.name} must be a named ${operation.kind} document`);
  }
  if (operation.name !== operation.operationName) {
    throw new TypeError('operation name aliases must match');
  }
  if (operation.responseSchema !== operation.dataSchema) {
    throw new TypeError(`${operation.name} data schema aliases must reference the same schema`);
  }
  if (!trimmed.includes(operation.operationName)) {
    throw new TypeError(`${operation.name} document must contain its operation name`);
  }
  if (trimmed.includes('__schema') || trimmed.includes('__type')) {
    throw new TypeError(`${operation.name} must not perform introspection`);
  }
  return Object.freeze(operation);
}
