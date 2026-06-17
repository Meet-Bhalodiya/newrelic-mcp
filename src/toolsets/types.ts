import type { ZodType } from 'zod';

import type { NerdGraphOperation, NerdGraphOperationExecutor } from '../operations/index.js';

export const TOOLSET_NAMES = [
  'core',
  'nrql',
  'entities',
  'alerts',
  'dashboards',
  'synthetics',
  'workloads',
  'service-levels',
  'logs',
  'metrics',
  'admin',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export interface CapabilityGates {
  readonly enabledToolsets?: readonly ToolsetName[] | ReadonlySet<ToolsetName>;
  readonly writes?: boolean;
  readonly destructive?: boolean;
  readonly admin?: boolean;
  readonly previewApis?: boolean;
  readonly experimentalAiIssues?: boolean;
}

export interface ToolExecutionContext {
  readonly executor: NerdGraphOperationExecutor;
  readonly gates: CapabilityGates;
  readonly defaultAccountId?: number;
  readonly accountAllowlist?: ReadonlySet<number> | readonly number[];
  readonly region?: 'US' | 'EU' | 'JP';
  readonly maxResponseBytes?: number;
  readonly requestId?: string | (() => string);
  readonly now?: () => number;
}

export interface StandardToolMeta {
  readonly requestId: string;
  readonly durationMs: number;
  readonly region?: 'US' | 'EU' | 'JP';
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly operationName?: string;
}

export interface StandardToolResult {
  readonly ok: true;
  readonly data: unknown;
  readonly pagination?: {
    readonly nextCursor?: string | null;
    readonly totalCount?: number;
  };
  readonly meta: StandardToolMeta;
}

export interface McpToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: StandardToolResult;
}

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: true;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: ToolsetName;
  readonly inputSchema: ZodType<Record<string, unknown>>;
  readonly operation: NerdGraphOperation;
  readonly resolveOperation?: (arguments_: Record<string, unknown>) => NerdGraphOperation;
  readonly annotations: ToolAnnotations;
  readonly requiredScope: 'newrelic:read' | 'newrelic:write' | 'newrelic:admin';
  readonly gate?: 'writes' | 'destructive' | 'admin' | 'previewApis' | 'experimentalAiIssues';
  readonly additionalGates?: readonly (
    'writes' | 'destructive' | 'admin' | 'previewApis' | 'experimentalAiIssues'
  )[];
  readonly sourceUrl: string;
  readonly handler: (
    arguments_: unknown,
    options?: { readonly signal?: AbortSignal; readonly requestId?: string },
  ) => Promise<McpToolResult>;
}

export interface InternalToolSpec extends Omit<
  ToolDefinition,
  'handler' | 'annotations' | 'sourceUrl'
> {
  readonly operation: NerdGraphOperation;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly mapVariables?: (arguments_: Record<string, unknown>) => Record<string, unknown>;
  readonly mapResult?: (data: unknown, arguments_: Record<string, unknown>) => unknown;
  /** Composite connections expose their cursors inside data instead of a misleading single cursor. */
  readonly omitPagination?: boolean;
  readonly requiredEventTypes?: readonly string[];
  readonly fixedNrql?: (arguments_: Record<string, unknown>) => string;
  readonly preReadOperation?: NerdGraphOperation;
  readonly mapPreReadVariables?: (arguments_: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Cursor connections that must be walked when a target is not present on the
   * first pre-read page. Pages are bounded and merged only until validation
   * succeeds, so a write can never turn an incomplete search into not_found.
   */
  readonly preReadConnections?: readonly {
    readonly cursorVariable: string;
    readonly path: readonly string[];
  }[];
  readonly maxPreReadPages?: number;
  /** Fail closed when the targeted resource is absent or does not match the request. */
  readonly validatePreRead?: (data: unknown, arguments_: Record<string, unknown>) => void;
  /**
   * Retain only target and prerequisite state after validation. The projected
   * state is used for the dry-run preview and confirmation binding so unrelated
   * preceding pages cannot exhaust the response budget or invalidate approval.
   */
  readonly projectPreRead?: (data: unknown, arguments_: Record<string, unknown>) => unknown;
  /** Proves that a post-write read contains the requested state. Without this, results are partial. */
  readonly validateReadback?: (
    data: unknown,
    arguments_: Record<string, unknown>,
    applied: unknown,
  ) => void;
  /** True when this invocation performs a destructive/public-exposure action. */
  readonly requiresDestructive?: (arguments_: Record<string, unknown>) => boolean;
}
