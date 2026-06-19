import {
  ACCOUNT_ACCESS,
  CONNECTION_CHECK,
  ENTITY_GET,
  type NerdGraphExecutionResult,
  type NerdGraphOperation,
} from '../operations/index.js';
import { isComplexNrql } from '../security/nrql.js';
import { redactText } from '../security/redaction.js';
import { TOOL_CATALOG } from './catalog.js';
import { CapabilityError, MutationOutcomeError } from './errors.js';
import {
  areSpecGatesEnabled,
  assertAccountAllowlist,
  assertReadOnlyNrql,
  assertSpecGates,
  confirmationPhrase,
  filterResponseToAccountAllowlist,
  isToolsetEnabled,
  requestId,
} from './safety.js';
import type {
  CapabilityGates,
  InternalToolSpec,
  McpToolResult,
  StandardToolResult,
  ToolDefinition,
  ToolExecutionContext,
} from './types.js';

function omitUndefinedAndControls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, child]) => key !== 'dryRun' && key !== 'confirmation' && child !== undefined,
    ),
  );
}

function projectVariables(
  operation: NerdGraphOperation,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Set(
    [...operation.document.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/gu)].map((match) => match[1]),
  );
  return Object.fromEntries(Object.entries(variables).filter(([key]) => declared.has(key)));
}

function redactPreview(value: unknown, key = ''): unknown {
  if (
    /(?:api.?key|token|authorization|password|secret|credential|private.?key|script|headers?)/iu.test(
      key,
    )
  ) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map((child) => redactPreview(child));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactPreview(child, childKey),
      ]),
    );
  }
  return typeof value === 'string' ? redactText(value, 16_384) : value;
}

function addDefaultAccount(
  arguments_: Record<string, unknown>,
  operations: readonly NerdGraphOperation[],
  context: ToolExecutionContext,
): Record<string, unknown> {
  if (arguments_.accountId !== undefined) return arguments_;
  if (context.defaultAccountId !== undefined) {
    return { ...arguments_, accountId: context.defaultAccountId };
  }
  if (!operations.some(({ document }) => document.includes('$accountId'))) return arguments_;
  throw new CapabilityError(
    'validation',
    'accountId is required because NEW_RELIC_DEFAULT_ACCOUNT_ID is not configured',
  );
}

function scopeEntitySearchQuery(
  arguments_: Record<string, unknown>,
  operation: NerdGraphOperation,
  context: ToolExecutionContext,
): Record<string, unknown> {
  if (
    operation.operationName !== 'EntitySearch' ||
    typeof arguments_.query !== 'string' ||
    !context.accountAllowlist ||
    new Set(context.accountAllowlist).size === 0
  ) {
    return arguments_;
  }
  const accountIds = [...new Set(context.accountAllowlist)].sort((left, right) => left - right);
  if (accountIds.length === 0) {
    throw new CapabilityError('authorization', 'The configured account allowlist is empty');
  }
  return {
    ...arguments_,
    query: `(${arguments_.query}) AND accountId IN (${accountIds.join(',')})`,
  };
}

function defaultPreRead(
  spec: InternalToolSpec,
  arguments_: Record<string, unknown>,
): {
  operation: NerdGraphOperation;
  variables: Record<string, unknown>;
} {
  if (spec.preReadOperation) {
    return {
      operation: spec.preReadOperation,
      variables: spec.mapPreReadVariables?.(arguments_) ?? arguments_,
    };
  }
  if (typeof arguments_.accountId === 'number') {
    return { operation: ACCOUNT_ACCESS, variables: { accountId: arguments_.accountId } };
  }
  if (typeof arguments_.guid === 'string') {
    return { operation: ENTITY_GET, variables: { guid: arguments_.guid } };
  }
  return { operation: CONNECTION_CHECK, variables: {} };
}

interface PreReadExecution {
  readonly result: NerdGraphExecutionResult;
  readonly authorizedData: unknown;
}

interface CursorState {
  readonly cursorVariable: string;
  readonly path: readonly string[];
  nextCursor: string | null;
  readonly seen: Set<string>;
}

function objectAtPath(data: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nextCursorAt(data: unknown, path: readonly string[]): string | null {
  const connection = objectAtPath(data, path);
  if (connection === undefined || !Object.hasOwn(connection, 'nextCursor')) {
    throw new CapabilityError(
      'upstream_schema',
      'A paginated write pre-read omitted its cursor connection',
      { path: path.join('.') },
    );
  }
  const cursor = connection.nextCursor;
  if (cursor !== null && typeof cursor !== 'string') {
    throw new CapabilityError(
      'upstream_schema',
      'A paginated write pre-read returned an invalid cursor',
      { path: [...path, 'nextCursor'].join('.') },
    );
  }
  return cursor;
}

function mergeConnectionPage(aggregate: unknown, page: unknown, path: readonly string[]): void {
  const destination = objectAtPath(aggregate, path);
  const source = objectAtPath(page, path);
  if (destination === undefined || source === undefined) {
    throw new CapabilityError(
      'upstream_schema',
      'A paginated write pre-read omitted a connection page',
      { path: path.join('.') },
    );
  }
  for (const [key, value] of Object.entries(source)) {
    const existing = destination[key];
    destination[key] =
      Array.isArray(existing) && Array.isArray(value)
        ? [...(existing as unknown[]), ...(value as unknown[])]
        : value;
  }
}

function assertCompletePreRead(result: NerdGraphExecutionResult): void {
  if (result.partial === true || result.truncated === true) {
    throw new CapabilityError(
      'upstream_schema',
      'The write pre-read was incomplete, so no confirmation or mutation was issued',
      { partial: result.partial === true, truncated: result.truncated === true },
    );
  }
}

function validatePreReadOrReturnNotFound(
  spec: InternalToolSpec,
  data: unknown,
  arguments_: Record<string, unknown>,
): CapabilityError | undefined {
  try {
    spec.validatePreRead?.(data, arguments_);
    return undefined;
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') return error;
    throw error;
  }
}

function projectValidatedPreRead(
  spec: InternalToolSpec,
  data: unknown,
  arguments_: Record<string, unknown>,
): unknown {
  return spec.projectPreRead?.(data, arguments_) ?? data;
}

async function executeCompletePreRead(
  spec: InternalToolSpec,
  operation: NerdGraphOperation,
  initialVariables: Record<string, unknown>,
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  options: { readonly signal?: AbortSignal; readonly requestId: string },
): Promise<PreReadExecution> {
  const executePage = async (variables: Record<string, unknown>) => {
    const result = await context.executor.execute(
      operation,
      projectVariables(operation, omitUndefinedAndControls(variables)),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        bypassCache: true,
        requestId: options.requestId,
      },
    );
    assertCompletePreRead(result);
    return result;
  };

  const first = await executePage(initialVariables);
  const firstAuthorizedPage = filterResponseToAccountAllowlist(first.data, context);
  const aggregate = structuredClone(firstAuthorizedPage);
  let authorizedData = aggregate;
  let notFoundError = validatePreReadOrReturnNotFound(spec, authorizedData, arguments_);
  if (notFoundError === undefined) {
    return {
      result: first,
      authorizedData: projectValidatedPreRead(spec, authorizedData, arguments_),
    };
  }

  const connections = spec.preReadConnections ?? [];
  if (connections.length === 0) throw notFoundError;
  const states: CursorState[] = connections.map(({ cursorVariable, path }) => {
    const nextCursor = nextCursorAt(first.data, path);
    return {
      cursorVariable,
      path,
      nextCursor,
      seen: new Set(nextCursor === null ? [] : [nextCursor]),
    };
  });
  const warnings = [...(first.warnings ?? [])];
  const maxPages = Math.max(1, Math.min(spec.maxPreReadPages ?? 50, 100));
  let pagesRead = 1;

  while (states.some(({ nextCursor }) => nextCursor !== null)) {
    if (pagesRead >= maxPages) {
      throw new CapabilityError(
        'upstream_schema',
        'The write pre-read exceeded its bounded pagination limit',
        { maxPages },
      );
    }
    const active = states.filter(({ nextCursor }) => nextCursor !== null);
    const pageVariables = {
      ...initialVariables,
      ...Object.fromEntries(active.map((state) => [state.cursorVariable, state.nextCursor])),
    };
    const page = await executePage(pageVariables);
    pagesRead += 1;
    warnings.push(...(page.warnings ?? []));
    // Validate every page's ownership envelope before discarding its parents and
    // merging only the nested connection. Otherwise a later page from another
    // account could inherit the first page's trusted account identity.
    const authorizedPage = filterResponseToAccountAllowlist(page.data, context);

    for (const state of active) {
      mergeConnectionPage(aggregate, authorizedPage, state.path);
      const nextCursor = nextCursorAt(authorizedPage, state.path);
      if (nextCursor !== null && state.seen.has(nextCursor)) {
        throw new CapabilityError(
          'upstream_schema',
          'The write pre-read returned a repeated cursor',
          { path: state.path.join('.') },
        );
      }
      if (nextCursor !== null) state.seen.add(nextCursor);
      state.nextCursor = nextCursor;
    }

    authorizedData = aggregate;
    notFoundError = validatePreReadOrReturnNotFound(spec, authorizedData, arguments_);
    if (notFoundError === undefined) {
      return {
        result: { ...first, data: aggregate, warnings },
        authorizedData: projectValidatedPreRead(spec, authorizedData, arguments_),
      };
    }
  }

  throw notFoundError;
}

function output(structuredContent: StandardToolResult): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function buildHandler(
  spec: InternalToolSpec,
  context: ToolExecutionContext,
): ToolDefinition['handler'] {
  return async (rawArguments, options): Promise<McpToolResult> => {
    assertSpecGates(spec, context.gates);
    const startedAt = (context.now ?? Date.now)();
    const currentRequestId = options?.requestId ?? requestId(context);
    const parsed = spec.inputSchema.safeParse(rawArguments);
    if (!parsed.success) {
      throw new CapabilityError('validation', 'Invalid tool arguments', {
        issues: parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })),
      });
    }

    if (spec.requiresDestructive?.(parsed.data) === true && context.gates.destructive !== true) {
      throw new CapabilityError(
        'write_disabled',
        `${spec.name} requires the destructive capability gate for these arguments`,
      );
    }

    const initialOperation = spec.resolveOperation?.(parsed.data) ?? spec.operation;
    let arguments_ = addDefaultAccount(
      parsed.data,
      [initialOperation, spec.preReadOperation ?? initialOperation],
      context,
    );
    arguments_ = scopeEntitySearchQuery(arguments_, initialOperation, context);
    assertAccountAllowlist(arguments_, context);

    if (spec.fixedNrql) {
      arguments_ = { ...arguments_, nrql: spec.fixedNrql(arguments_) };
    }
    const suppliedNrql = arguments_.nrql ?? arguments_.query;
    if (typeof suppliedNrql === 'string' && initialOperation.complexNrql === true) {
      const boundedNrql = assertReadOnlyNrql(suppliedNrql, spec.requiredEventTypes);
      arguments_ =
        arguments_.nrql === suppliedNrql
          ? { ...arguments_, nrql: boundedNrql }
          : { ...arguments_, query: boundedNrql };
    }

    const resolvedOperation = spec.resolveOperation?.(arguments_) ?? spec.operation;
    const boundedNrql = arguments_.nrql ?? arguments_.query;
    const selectedOperation =
      resolvedOperation.complexNrql === true && typeof boundedNrql === 'string'
        ? { ...resolvedOperation, complexNrql: isComplexNrql(boundedNrql) }
        : resolvedOperation;
    const mappedVariables = projectVariables(
      selectedOperation,
      omitUndefinedAndControls(spec.mapVariables?.(arguments_) ?? arguments_),
    );
    const isWrite = selectedOperation.kind === 'mutation';
    const warnings: string[] = [];

    if (isWrite) {
      const preRead = defaultPreRead(spec, arguments_);
      const preReadArguments = addDefaultAccount(preRead.variables, [preRead.operation], context);
      assertAccountAllowlist(preReadArguments, context);
      const completedPreRead = await executeCompletePreRead(
        spec,
        preRead.operation,
        preReadArguments,
        arguments_,
        context,
        {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          requestId: currentRequestId,
        },
      );
      const before = completedPreRead.result;
      const authorizedBefore = completedPreRead.authorizedData;

      // Bind approval to both the normalized request and the authorized pre-read. A confirmation
      // cannot be replayed after another operator changes the resource.
      const phrase = confirmationPhrase(spec.name, arguments_, authorizedBefore);
      if (arguments_.dryRun !== false) {
        const structuredContent: StandardToolResult = {
          ok: true,
          data: {
            dryRun: true,
            before: redactPreview(authorizedBefore),
            requested: redactPreview(omitUndefinedAndControls(arguments_)),
            diff: {
              strategy: 'normalized-before-and-requested',
              before: redactPreview(authorizedBefore),
              after: redactPreview(omitUndefinedAndControls(arguments_)),
            },
            confirmationPhrase: phrase,
          },
          meta: {
            requestId: currentRequestId,
            durationMs: (context.now ?? Date.now)() - startedAt,
            ...(context.region === undefined ? {} : { region: context.region }),
            partial: false,
            truncated: false,
            warnings: [...warnings, ...(before.warnings ?? [])],
            operationName: selectedOperation.operationName,
          },
        };
        return output(structuredContent);
      }

      if (arguments_.confirmation !== phrase) {
        throw new CapabilityError(
          'confirmation_required',
          'The exact confirmation phrase from a dry-run with identical arguments is required',
          { confirmationPhrase: phrase },
        );
      }

      let applied: NerdGraphExecutionResult;
      try {
        applied = await context.executor.execute(selectedOperation, mappedVariables, {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          requestId: currentRequestId,
        });
      } catch (error) {
        throw new MutationOutcomeError(error);
      }
      let after: unknown;
      let readbackPartial = false;
      let readbackTruncated = false;
      let readbackFailed = false;
      let readbackVerified = false;
      try {
        const completedReadback = await executeCompletePreRead(
          spec,
          preRead.operation,
          preReadArguments,
          arguments_,
          context,
          {
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
            requestId: currentRequestId,
          },
        );
        const readback = completedReadback.result;
        const authorizedReadback = completedReadback.authorizedData;
        after = redactPreview(authorizedReadback);
        readbackPartial = readback.partial === true;
        readbackTruncated = readback.truncated === true;
        if (readbackPartial) warnings.push('Post-write readback returned partial data.');
        if (readbackTruncated) warnings.push('Post-write readback was truncated.');
        if (!readbackPartial && !readbackTruncated && spec.validateReadback !== undefined) {
          spec.validateReadback(authorizedReadback, arguments_, applied.data);
          readbackVerified = true;
        } else if (!readbackPartial && !readbackTruncated) {
          warnings.push(
            'Post-write state was read back but could not be automatically verified; verify the target directly.',
          );
        }
      } catch {
        readbackFailed = true;
        warnings.push(
          'The mutation completed, but post-write readback failed; verify the resource directly.',
        );
      }
      const structuredContent: StandardToolResult = {
        ok: true,
        data: {
          applied: redactPreview(filterResponseToAccountAllowlist(applied.data, context)),
          after,
          verification: { verified: readbackVerified },
        },
        ...(spec.omitPagination === true || applied.pagination === undefined
          ? {}
          : { pagination: applied.pagination }),
        meta: {
          requestId: currentRequestId,
          durationMs: (context.now ?? Date.now)() - startedAt,
          ...(context.region === undefined ? {} : { region: context.region }),
          partial:
            applied.partial === true || readbackPartial || readbackFailed || !readbackVerified,
          truncated: applied.truncated === true || readbackTruncated,
          warnings: [...warnings, ...(applied.warnings ?? [])],
          operationName: selectedOperation.operationName,
        },
      };
      return output(structuredContent);
    }

    const result = await context.executor.execute(selectedOperation, mappedVariables, {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      requestId: currentRequestId,
    });
    const authorizedData = filterResponseToAccountAllowlist(result.data, context);
    const structuredContent: StandardToolResult = {
      ok: true,
      data: spec.mapResult?.(authorizedData, arguments_) ?? authorizedData,
      ...(spec.omitPagination === true || result.pagination === undefined
        ? {}
        : { pagination: result.pagination }),
      meta: {
        requestId: currentRequestId,
        durationMs: (context.now ?? Date.now)() - startedAt,
        ...(context.region === undefined ? {} : { region: context.region }),
        partial: result.partial === true,
        truncated: result.truncated === true,
        warnings: result.warnings ?? [],
        operationName: selectedOperation.operationName,
      },
    };
    return output(structuredContent);
  };
}

export function enabledToolNames(gates: CapabilityGates): readonly string[] {
  return TOOL_CATALOG.filter(
    (spec) => isToolsetEnabled(gates, spec.toolset) && areSpecGatesEnabled(spec, gates),
  ).map(({ name }) => name);
}

export function buildToolDefinitions(context: ToolExecutionContext): readonly ToolDefinition[] {
  return TOOL_CATALOG.filter(
    (spec) =>
      isToolsetEnabled(context.gates, spec.toolset) && areSpecGatesEnabled(spec, context.gates),
  ).map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    toolset: spec.toolset,
    inputSchema: spec.inputSchema,
    operation: spec.operation,
    ...(spec.resolveOperation === undefined ? {} : { resolveOperation: spec.resolveOperation }),
    annotations: {
      readOnlyHint: spec.operation.kind === 'query',
      destructiveHint: spec.destructive === true || spec.requiresDestructive !== undefined,
      idempotentHint: spec.idempotent === true,
      openWorldHint: true,
    },
    requiredScope: spec.requiredScope,
    ...(spec.gate === undefined ? {} : { gate: spec.gate }),
    ...(spec.additionalGates === undefined ? {} : { additionalGates: spec.additionalGates }),
    sourceUrl: spec.operation.sourceUrl,
    handler: buildHandler(spec, context),
  }));
}
