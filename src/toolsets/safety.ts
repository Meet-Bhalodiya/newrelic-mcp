import { createHash, randomUUID } from 'node:crypto';

import { ensureBoundedNrql, nrqlControlText } from '../security/index.js';
import { collectReferencedAccountIds } from '../security/account.js';

import type {
  CapabilityGates,
  InternalToolSpec,
  ToolExecutionContext,
  ToolsetName,
} from './types.js';
import { CapabilityError } from './errors.js';

export function assertReadOnlyNrql(
  query: string,
  requiredEventTypes: readonly string[] = [],
): string {
  let bounded: string;
  try {
    bounded = ensureBoundedNrql(query, 100, 5_000);
  } catch (error) {
    throw new CapabilityError(
      'validation',
      error instanceof Error ? error.message : 'Invalid read-only NRQL',
    );
  }
  const code = nrqlControlText(bounded).trim();
  if (requiredEventTypes.length > 0) {
    const allowed = new Set(
      requiredEventTypes.map((eventType) => eventType.toLocaleUpperCase('en-US')),
    );
    const sources = [
      ...code
        .toLocaleUpperCase('en-US')
        .matchAll(/\bFROM\s+([A-Z_][A-Z0-9_]*(?:\s*,\s*[A-Z_][A-Z0-9_]*)*)/gu),
    ]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((source) => source.trim())
      .filter(Boolean);
    if (sources.length === 0 || sources.some((source) => !allowed.has(source))) {
      throw new CapabilityError(
        'validation',
        `This tool only permits NRQL over: ${requiredEventTypes.join(', ')}`,
      );
    }
  }
  return bounded;
}

function normalizeForConfirmation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForConfirmation);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'confirmation' && key !== 'dryRun')
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      entries.map(([key, child]) => [key, normalizeForConfirmation(child)]),
    );
  }
  return value;
}

export function confirmationPhrase(
  toolName: string,
  arguments_: Record<string, unknown>,
  currentState?: unknown,
): string {
  const payload = JSON.stringify({
    arguments: normalizeForConfirmation(arguments_),
    ...(currentState === undefined ? {} : { currentState: normalizeForConfirmation(currentState) }),
  });
  const digest = createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  return `APPLY ${toolName} ${digest}`;
}

export function requestId(context: ToolExecutionContext): string {
  return typeof context.requestId === 'function'
    ? context.requestId()
    : (context.requestId ?? randomUUID());
}

export function isToolsetEnabled(gates: CapabilityGates, toolset: ToolsetName): boolean {
  if (!gates.enabledToolsets) return true;
  return new Set(gates.enabledToolsets).has(toolset);
}

export function areSpecGatesEnabled(
  spec: Pick<InternalToolSpec, 'gate' | 'additionalGates'>,
  gates: CapabilityGates,
): boolean {
  return [spec.gate, ...(spec.additionalGates ?? [])]
    .filter((gate): gate is NonNullable<typeof gate> => gate !== undefined)
    .every((gate) => gates[gate] === true);
}

export function assertSpecGates(
  spec: Pick<InternalToolSpec, 'name' | 'gate' | 'additionalGates'>,
  gates: CapabilityGates,
): void {
  for (const gate of [spec.gate, ...(spec.additionalGates ?? [])]) {
    if (gate && gates[gate] !== true) {
      throw new CapabilityError(
        gate === 'writes' || gate === 'destructive' ? 'write_disabled' : 'authorization',
        `${spec.name} requires the ${gate} capability gate`,
      );
    }
  }
}

export function assertAccountAllowlist(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
): void {
  let referencedAccountIds: readonly number[];
  try {
    referencedAccountIds = collectReferencedAccountIds(arguments_, 'arguments');
  } catch {
    throw new CapabilityError('authorization', 'An account reference is invalid');
  }
  if (!context.accountAllowlist || new Set(context.accountAllowlist).size === 0) return;
  const allowed = new Set(context.accountAllowlist);
  for (const accountId of referencedAccountIds) {
    if (!allowed.has(accountId)) {
      throw new CapabilityError(
        'authorization',
        `Account ${accountId} is outside the configured allowlist`,
      );
    }
  }
}

const OMIT = Symbol('omit-disallowed-account-data');

function directAccountIds(object: Record<string, unknown>, containerKey: string): number[] {
  const references: unknown[] = [];
  for (const [key, child] of Object.entries(object)) {
    if (/account(?:[_-]?ids?)$/iu.test(key)) {
      if (Array.isArray(child)) {
        for (const reference of child as unknown[]) references.push(reference);
      } else {
        references.push(child);
      }
    }
  }
  if (/accounts?$/iu.test(containerKey) && object.id !== undefined) references.push(object.id);
  if (String(object.type).toLocaleUpperCase('en-US') === 'ACCOUNT' && object.id !== undefined) {
    references.push(object.id);
  }
  const scope = object.scope;
  if (scope && typeof scope === 'object') {
    const scopeObject = scope as Record<string, unknown>;
    if (
      String(scopeObject.type).toLocaleUpperCase('en-US') === 'ACCOUNT' &&
      scopeObject.id !== undefined
    ) {
      references.push(scopeObject.id);
    }
  }
  return references.map((reference) => {
    const accountId =
      typeof reference === 'number'
        ? reference
        : typeof reference === 'string' && /^\d+$/u.test(reference)
          ? Number(reference)
          : Number.NaN;
    if (!Number.isSafeInteger(accountId) || accountId < 1 || accountId > 2_147_483_647) {
      throw new CapabilityError(
        'authorization',
        'Upstream data contained an invalid account reference',
      );
    }
    return accountId;
  });
}

/** Remove mixed-list entries and reject direct objects outside the configured account allowlist. */
export function filterResponseToAccountAllowlist(
  data: unknown,
  context: ToolExecutionContext,
): unknown {
  if (!context.accountAllowlist || new Set(context.accountAllowlist).size === 0) return data;
  const allowed = new Set(context.accountAllowlist);
  const visit = (
    value: unknown,
    key = '',
    inArray = false,
    inheritedAccountOwnership = false,
  ): unknown => {
    if (Array.isArray(value)) {
      return value
        .map((entry) => visit(entry, key, true, inheritedAccountOwnership))
        .filter((entry) => entry !== OMIT);
    }
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.spans)) {
      if (
        !Array.isArray(object.entities) ||
        (object.spans.length > 0 && object.entities.length === 0)
      ) {
        throw new CapabilityError(
          'authorization',
          'Trace ownership could not be verified against the configured account allowlist',
        );
      }
      const entityGuids = new Set<string>();
      for (const entity of object.entities) {
        const accountId =
          entity && typeof entity === 'object'
            ? (entity as Record<string, unknown>).accountId
            : undefined;
        const entityGuid =
          entity && typeof entity === 'object'
            ? (entity as Record<string, unknown>).guid
            : undefined;
        if (typeof accountId !== 'number' || typeof entityGuid !== 'string') {
          throw new CapabilityError('authorization', 'Trace ownership data was incomplete');
        }
        entityGuids.add(entityGuid);
        if (!allowed.has(accountId)) {
          throw new CapabilityError(
            'authorization',
            `Trace data spans account ${accountId}, outside the configured allowlist`,
          );
        }
      }
      const referencesUnknownEntity = object.spans.some((span) => {
        if (!span || typeof span !== 'object') return true;
        const entityGuid = (span as Record<string, unknown>).entityGuid;
        return typeof entityGuid !== 'string' || !entityGuids.has(entityGuid);
      });
      if (referencesUnknownEntity) {
        throw new CapabilityError(
          'authorization',
          'Trace spans referenced an entity whose account ownership was unavailable',
        );
      }
    }
    const referencedAccountIds = directAccountIds(object, key);
    const disallowedAccountId = referencedAccountIds.find((accountId) => !allowed.has(accountId));
    if (disallowedAccountId !== undefined) {
      if (inArray) return OMIT;
      throw new CapabilityError(
        'authorization',
        `Upstream data belongs to account ${disallowedAccountId}, outside the configured allowlist`,
      );
    }
    const accountContainer = key === 'account' || key === 'accounts';
    const entityContainer = key === 'entity' || key === 'entities';
    if (
      (accountContainer || entityContainer) &&
      !inheritedAccountOwnership &&
      referencedAccountIds.length === 0
    ) {
      throw new CapabilityError(
        'authorization',
        `Upstream ${accountContainer ? 'account' : 'entity'} data omitted the ownership field required by the allowlist`,
      );
    }
    const verifiedAccountOwnership = inheritedAccountOwnership || referencedAccountIds.length > 0;
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(object)) {
      const visited = visit(child, childKey, false, verifiedAccountOwnership);
      if (visited !== OMIT) result[childKey] = visited;
    }
    return result;
  };
  const filtered = visit(data);
  return filtered === OMIT ? null : filtered;
}
