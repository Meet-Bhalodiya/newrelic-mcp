import {
  Kind,
  parse,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import {
  NerdGraphClient,
  type NerdGraphOperation as ClientOperation,
} from '../../src/newrelic/index.js';
import { NERDGRAPH_OPERATIONS, type NerdGraphOperation } from '../../src/operations/index.js';

function client(fetch: typeof globalThis.fetch): NerdGraphClient {
  return new NerdGraphClient({
    apiKey: 'NRAK-contract-fixture',
    endpoint: 'https://api.newrelic.com/graphql',
    region: 'US',
    allowMutations: true,
    maxReadRetries: 0,
    timeoutMs: 100,
    fetch,
  });
}

type JsonSchema = Readonly<Record<string, unknown>>;

function schemaRecord(value: unknown): JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalarVariableFixture(schema: JsonSchema, path: readonly string[]): unknown {
  const field = path.at(-1) ?? '';
  if (field === 'nrql') {
    return path.includes('pipelineCloudRuleEntity')
      ? ('DELETE FROM TestEvent' as const)
      : ('SELECT count(*) FROM Transaction' as const);
  }
  if (field === 'query' && path.some((segment) => segment === 'nrql')) {
    return 'SELECT count(*) FROM Transaction' as const;
  }
  if (field === 'query' && path.some((segment) => segment === 'configuration')) {
    return 'SELECT count(*) FROM Transaction' as const;
  }
  if (field === 'uri') return 'https://example.com';
  if (field === 'email') return 'fixture@example.com';
  if (field === 'matchExpression') return '^fixture$';
  if (field === 'from') return 'Transaction';
  if (field === 'startTime' || field === 'onDate') return '2026-01-01T00:00:00';

  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
    if (typeof schema.minimum === 'number') return schema.minimum;
    return 1;
  }
  if (schema.type === 'null') return null;
  if (schema.type === 'string') {
    if (typeof schema.pattern === 'string' && schema.pattern.includes('\\d{4}')) {
      return '2026-01-01T00:00:00';
    }
    const minimumLength = typeof schema.minLength === 'number' ? Math.max(1, schema.minLength) : 1;
    return 'x'.repeat(minimumLength);
  }
  return undefined;
}

/** Build valid variables from the real Zod contract, never from GraphQL text. */
function variableFixtureForSchema(
  schema: unknown,
  path: readonly string[] = [],
  root: JsonSchema = schemaRecord(schema),
): unknown {
  const definition = schemaRecord(schema);
  if (typeof definition.$ref === 'string') {
    const segments = definition.$ref.replace(/^#\//u, '').split('/');
    let resolved: unknown = root;
    for (const segment of segments) resolved = schemaRecord(resolved)[segment];
    return variableFixtureForSchema(resolved, path, root);
  }
  const alternatives = Array.isArray(definition.anyOf)
    ? definition.anyOf
    : Array.isArray(definition.oneOf)
      ? definition.oneOf
      : undefined;
  if (alternatives !== undefined) {
    const nonNull = alternatives.find((candidate) => schemaRecord(candidate).type !== 'null');
    return variableFixtureForSchema(nonNull ?? alternatives[0], path, root);
  }
  if (Array.isArray(definition.allOf)) {
    const merged = Object.assign({}, ...definition.allOf.map((entry) => schemaRecord(entry)));
    return variableFixtureForSchema(merged, path, root);
  }
  if (definition.type === 'object') {
    const properties = schemaRecord(definition.properties);
    const required = new Set(
      Array.isArray(definition.required)
        ? definition.required.filter((name): name is string => typeof name === 'string')
        : [],
    );
    // Refinements such as update/non-empty and location/one-of constraints are
    // not expressible in JSON Schema. Supplying the first optional property is
    // a deterministic representative that satisfies those fixed contracts.
    const firstOptional = Object.keys(properties).find((name) => !required.has(name));
    if (firstOptional !== undefined) required.add(firstOptional);
    return Object.fromEntries(
      [...required].map((name) => [
        name,
        variableFixtureForSchema(properties[name], [...path, name], root),
      ]),
    );
  }
  if (definition.type === 'array') {
    const minimum = typeof definition.minItems === 'number' ? definition.minItems : 0;
    return Array.from({ length: minimum }, (_, index) =>
      variableFixtureForSchema(definition.items, [...path, String(index)], root),
    );
  }
  return scalarVariableFixture(definition, path);
}

function variablesFor(operation: NerdGraphOperation): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(operation.variablesSchema);
  const fixture = variableFixtureForSchema(jsonSchema);
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new TypeError(`${operation.operationName} did not produce object variables`);
  }
  const result = operation.variablesSchema.safeParse(fixture);
  if (!result.success) {
    throw new TypeError(
      `${operation.operationName} representative variables are invalid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

const QUERY_OBJECT_LIST_PATHS = new Set([
  'actor.accounts',
  'actor.entities',
  'actor.entity.metadata',
  'actor.entity.pages',
  'actor.entity.pages.widgets',
  'actor.entity.relatedEntities.results',
  'actor.entity.serviceLevel.indicators',
  'actor.entity.serviceLevel.indicators.objectives',
  'actor.entity.tags',
  'actor.entity.variables',
  'actor.entity.variables.defaultValues',
  'actor.entity.collection.members.results.entities',
  'actor.entity.goldenMetrics.metrics',
  'actor.entity.goldenTags.tags',
  'actor.entitySearch.results.entities',
  'actor.entitySearch.results.entities.tags',
  'actor.distributedTracing.trace.entities',
  'actor.distributedTracing.trace.spanConnections',
  'actor.distributedTracing.trace.spans',
  'actor.distributedTracing.trace.spans.spanAnomalies',
  'actor.account.alerts.policiesSearch.policies',
  'actor.account.alerts.nrqlConditionsSearch.nrqlConditions',
  'actor.account.alerts.mutingRules.rules',
  'actor.account.alerts.mutingRules.rules.condition.conditions',
  'actor.account.aiNotifications.destinations.entities',
  'actor.account.aiNotifications.channels.entities',
  'actor.account.aiWorkflows.workflows.entities',
  'actor.maintenanceWindow.listByIds.maintenanceWindows',
  'actor.account.logConfigurations.dataPartitionRules',
  'actor.account.logConfigurations.parsingRules',
  'actor.account.logConfigurations.obfuscationExpressions',
  'actor.account.logConfigurations.obfuscationRules',
  'actor.account.logConfigurations.obfuscationRules.actions',
  'actor.account.metricNormalization.metricNormalizationRules',
  'actor.entityManagement.entitySearch.entities',
  'actor.apiAccess.keySearch.keys',
  'customerAdministration.authenticationDomains.items',
  'customerAdministration.groups.items',
  'customerAdministration.grants.items',
  'customerAdministration.roles.items',
  'customerAdministration.dataAccessPolicies.items',
  'customerAdministration.permissions.items',
  'customerAdministration.users.items',
]);

const MUTATION_OBJECT_LIST_FIELDS = new Set([
  'accessGrants',
  'actions',
  'daysOfWeek',
  'deletedKeys',
  'groups',
  'roles',
  'updatedKeys',
]);

const BOOLEAN_RESPONSE_FIELDS = new Set([
  'completed',
  'enabled',
  'isCanceled',
  'reporting',
  'shared',
  'terminateChain',
  'verifiedScriptExecution',
  'workflowEnabled',
]);

const NUMBER_RESPONSE_FIELDS = new Set([
  'accountId',
  'anomalousValue',
  'averageMeasure',
  'begin',
  'column',
  'count',
  'durationMs',
  'end',
  'entityCount',
  'evalOrder',
  'height',
  'locationsFailing',
  'locationsRunning',
  'numberDaysToFailBeforeCertExpires',
  'onRepeat',
  'resultExpiration',
  'retryAfter',
  'retryDeadline',
  'row',
  'successRate',
  'target',
  'timestamp',
  'totalCount',
  'version',
  'violationTimeLimitSeconds',
  'width',
]);

const NUMBER_RESPONSE_PATHS = new Set([
  'actor.account.metricNormalization.metricNormalizationRules.createdAt',
]);

const SCALAR_LIST_RESPONSE_FIELDS = new Set([
  'affectedEntities',
  'attributes',
  'daysOfMonth',
  'eventTypes',
  'facets',
  'ids',
  'maintenanceDays',
  'monitorGuids',
  'values',
]);

function responseScalar(field: string, path: string): unknown {
  if (field === 'policy' || field === 'rawConfiguration') return {};
  if (path.endsWith('.spans.attributes')) return {};
  if (path.endsWith('.nrql.results') || path.endsWith('.nrqlQueryProgress.results')) {
    return [{ count: 1 }];
  }
  if (SCALAR_LIST_RESPONSE_FIELDS.has(field)) return ['fixture'];
  if (BOOLEAN_RESPONSE_FIELDS.has(field)) return false;
  if (NUMBER_RESPONSE_PATHS.has(path)) return 1;
  if (NUMBER_RESPONSE_FIELDS.has(field)) return 1;
  if (
    field === 'id' &&
    (path === 'actor.account.id' ||
      path === 'actor.accounts.id' ||
      path === 'actor.entity.serviceLevel.indicators.events.account.id')
  ) {
    return 1;
  }
  return 'fixture';
}

function responseFieldFixture(
  field: FieldNode,
  parentPath: string,
  operationKind: 'query' | 'mutation',
): unknown {
  const fieldName = field.name.value;
  const path = parentPath === '' ? fieldName : `${parentPath}.${fieldName}`;
  if (field.selectionSet === undefined) return responseScalar(fieldName, path);
  if (fieldName === 'error') return null;
  if (fieldName === 'errors') return [];
  const value = responseSelectionFixture(field.selectionSet, path, operationKind);
  if (
    (operationKind === 'query' && QUERY_OBJECT_LIST_PATHS.has(path)) ||
    (operationKind === 'mutation' && MUTATION_OBJECT_LIST_FIELDS.has(fieldName))
  ) {
    return [value];
  }
  return value;
}

function responseSelectionFixture(
  selectionSet: SelectionSetNode,
  parentPath: string,
  operationKind: 'query' | 'mutation',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      result[selection.alias?.value ?? selection.name.value] = responseFieldFixture(
        selection,
        parentPath,
        operationKind,
      );
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      Object.assign(
        result,
        responseSelectionFixture(selection.selectionSet, parentPath, operationKind),
      );
    } else {
      throw new TypeError('Contract fixtures do not support named fragments');
    }
  }
  return result;
}

/** Response fixtures are derived from the fixed document, independently of Zod. */
function fixtureData(operation: NerdGraphOperation): Record<string, unknown> {
  const parsed = parse(operation.document, { noLocation: true });
  const definition = parsed.definitions.find(
    (candidate): candidate is OperationDefinitionNode =>
      candidate.kind === Kind.OPERATION_DEFINITION,
  );
  if (definition === undefined) throw new TypeError(`${operation.operationName} has no operation`);
  const fixture = responseSelectionFixture(definition.selectionSet, '', operation.kind);
  const validated = operation.responseSchema.safeParse(fixture);
  if (!validated.success) {
    throw new TypeError(
      `${operation.operationName} document fixture does not satisfy its response schema: ${z.prettifyError(validated.error)}`,
    );
  }
  return fixture;
}

function asClientOperation(
  operation: NerdGraphOperation,
): ClientOperation<Record<string, unknown>, unknown> {
  return {
    operationName: operation.operationName,
    document: operation.document,
    kind: operation.kind,
    variablesSchema: operation.variablesSchema,
    dataSchema: operation.responseSchema,
    ...(operation.complexNrql === undefined ? {} : { complexNrql: operation.complexNrql }),
    ...(operation.experimentalHeader === undefined
      ? {}
      : { experimentalHeader: operation.experimentalHeader }),
  };
}

describe('fixed NerdGraph operation contracts', () => {
  it('gives every operation a unique fixed document, real variable schema, and independent fixture', () => {
    expect(NERDGRAPH_OPERATIONS.length).toBeGreaterThan(100);
    expect(new Set(NERDGRAPH_OPERATIONS.map(({ operationName }) => operationName)).size).toBe(
      NERDGRAPH_OPERATIONS.length,
    );
    for (const operation of NERDGRAPH_OPERATIONS) {
      expect(operation.document).toMatch(
        new RegExp(`^${operation.kind}\\s+${operation.operationName}(?:\\s|\\()`, 'u'),
      );
      expect(operation.document).not.toContain('${');
      expect(operation.sourceUrl).toMatch(
        /^https:\/\/(?:docs\.newrelic\.com|github\.com\/newrelic)\//u,
      );
      expect(operation.variablesSchema.safeParse(variablesFor(operation)).success).toBe(true);
      expect(operation.responseSchema.safeParse(fixtureData(operation)).success).toBe(true);
    }
  });

  it('accepts success and preserves sanitized partial success for every operation', async () => {
    for (const operation of NERDGRAPH_OPERATIONS) {
      const variables = variablesFor(operation);
      const data = fixtureData(operation);
      const success = await client(() => Promise.resolve(Response.json({ data }))).execute(
        asClientOperation(operation),
        variables,
      );
      expect(success.partial, operation.operationName).toBe(false);

      const partialRequest = client(() =>
        Promise.resolve(
          Response.json({
            data,
            errors: [
              {
                message: 'Authorization: Bearer fixture-secret',
                path: ['fixture'],
                extensions: { code: 'FORBIDDEN' },
              },
            ],
          }),
        ),
      ).execute(asClientOperation(operation), variables);
      if (operation.kind === 'mutation') {
        const error: unknown = await partialRequest.catch((reason: unknown) => reason);
        if (!(error instanceof Error)) throw new TypeError('Expected a mutation error');
        expect(error.message, operation.operationName).toContain('outcome may be uncertain');
        expect(error.message, operation.operationName).not.toContain('fixture-secret');
        continue;
      }

      const partial = await partialRequest;
      expect(partial.partial, operation.operationName).toBe(true);
      expect(partial.errors[0]?.message, operation.operationName).not.toContain('fixture-secret');
    }
  });

  it('normalizes permission, entitlement, validation, rate-limit, and schema drift for every operation', async () => {
    for (const operation of NERDGRAPH_OPERATIONS) {
      const fixed = asClientOperation(operation);
      const variables = variablesFor(operation);
      await expect(
        client(() => Promise.resolve(new Response('', { status: 403 }))).execute(fixed, variables),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'authorization' });
      await expect(
        client(() =>
          Promise.resolve(
            Response.json({
              data: null,
              errors: [{ message: 'Feature unavailable', extensions: { code: 'NOT_ENTITLED' } }],
            }),
          ),
        ).execute(fixed, variables),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'unsupported' });
      await expect(
        client(() =>
          Promise.resolve(
            Response.json({
              data: null,
              errors: [
                {
                  message: 'The fixed operation failed validation',
                  extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
                },
              ],
            }),
          ),
        ).execute(fixed, variables),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'validation' });
      await expect(
        client(() => Promise.resolve(new Response('', { status: 429 }))).execute(fixed, variables),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'rate-limited' });
      await expect(
        client(() => Promise.resolve(Response.json({ data: [] }))).execute(fixed, variables),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'upstream-schema' });
    }
  });

  it('rejects invalid variables before I/O for every operation', async () => {
    for (const operation of NERDGRAPH_OPERATIONS) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        client(fetch).execute(asClientOperation(operation), {
          ...variablesFor(operation),
          __undeclaredContractVariable: true,
        }),
        operation.operationName,
      ).rejects.toMatchObject({ code: 'validation' });
      expect(fetch, operation.operationName).not.toHaveBeenCalled();
    }
  });

  it('maps a bounded timeout for every operation', async () => {
    const hangingFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    await Promise.all(
      NERDGRAPH_OPERATIONS.map(async (operation) => {
        await expect(
          client(hangingFetch).execute(asClientOperation(operation), variablesFor(operation)),
          operation.operationName,
        ).rejects.toMatchObject({ code: 'timeout' });
      }),
    );
  });
});
