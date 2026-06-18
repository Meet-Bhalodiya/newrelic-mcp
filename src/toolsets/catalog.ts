import { z, type ZodRawShape } from 'zod';

import {
  ACCOUNTS_LIST,
  ACCOUNT_ACCESS,
  ACCOUNT_AND_ENTITIES_GET,
  ADMIN_DATA_ACCESS_POLICIES_LIST,
  ADMIN_GRANTS_LIST,
  ADMIN_GROUPS_LIST,
  ADMIN_ROLES_LIST,
  ADMIN_RESOURCES_LIST,
  ADMIN_MEMBERSHIP_PREREAD,
  ADMIN_TARGETS_GET,
  ADMIN_USER_GET,
  ADMIN_USERS_LIST,
  ALERT_CONDITIONS_LIST,
  ALERT_CONDITION_GET,
  ALERT_POLICIES_LIST,
  ALERT_POLICY_GET,
  API_KEYS_LIST,
  CONNECTION_CHECK,
  DASHBOARDS_LIST,
  DASHBOARD_GET,
  ENTITY_GET,
  ENTITY_AND_ACCOUNT_GET,
  ENTITY_GOLDEN_DATA,
  ENTITY_PAIR_GET,
  ENTITY_RELATIONSHIPS,
  ENTITY_SEARCH,
  LOG_CONFIGURATIONS_LIST,
  MAINTENANCE_WINDOW_AND_ENTITIES,
  MAINTENANCE_WINDOWS_LIST,
  METRIC_NORMALIZATION_RULES_LIST,
  MUTATIONS,
  MUTING_RULES_LIST,
  NOTIFICATIONS_LIST,
  NRQL_ASYNC_CANCEL,
  NRQL_ASYNC_START,
  NRQL_ASYNC_STATUS,
  NRQL_QUERY,
  ORGANIZATION_GET,
  PIPELINE_RULES_LIST,
  SERVICE_LEVELS_LIST,
  SERVICE_LEVEL_GET,
  SERVICE_LEVEL_RESULTS,
  SYNTHETIC_DOWNTIMES_LIST,
  SYNTHETIC_LOCATIONS_LIST,
  SYNTHETIC_MONITORS_LIST,
  SYNTHETIC_MONITOR_GET,
  SYNTHETIC_SECURE_CREDENTIALS_LIST,
  TARGET_AND_ENTITIES_GET,
  TRACE_GET,
  WORKLOADS_LIST,
  WORKLOAD_GET,
  WORKLOAD_STATUS_GET,
  authorizationAccessSchema,
  accountIdSchema,
  cursorSchema,
  dashboardInputSchema,
  guidSchema,
  logConfigurationInputSchema,
  metricNormalizationInputSchema,
  pipelineDeleteNrqlSchema,
  readOnlyConfigurationNrqlSchema,
  validateDashboardNrql,
  writeControlsSchema,
  type NerdGraphOperation,
} from '../operations/index.js';
import { containsSecretBearingUrl } from '../security/redaction.js';
import { CapabilityError } from './errors.js';
import type { InternalToolSpec, ToolsetName } from './types.js';

const emptyInput = z.object({}).strict();
const accountInput = z.object({ accountId: accountIdSchema.optional() }).strict();
const accountPageInput = z
  .object({
    accountId: accountIdSchema.optional(),
    cursor: cursorSchema.optional(),
  })
  .strict();
const idSchema = z.string().min(1).max(512);

type JsonObject = Record<string, unknown>;

function objectAt(data: unknown, path: readonly string[]): JsonObject | undefined {
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as JsonObject)[segment];
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function arrayAt(data: unknown, path: readonly string[]): readonly unknown[] | undefined {
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as JsonObject)[segment];
  }
  return Array.isArray(value) ? value : undefined;
}

function notFound(resource: string, identifier: unknown): never {
  const printableIdentifier =
    typeof identifier === 'string' || typeof identifier === 'number'
      ? String(identifier)
      : undefined;
  throw new CapabilityError('not_found', `${resource} was not found`, {
    ...(printableIdentifier === undefined ? {} : { identifier: printableIdentifier }),
  });
}

function requireObjectId(
  data: unknown,
  path: readonly string[],
  expected: unknown,
  resource: string,
  field = 'id',
): JsonObject {
  const value = objectAt(data, path);
  if (value === undefined || String(value[field]) !== String(expected)) {
    return notFound(resource, expected);
  }
  return value;
}

function requireEntity(data: unknown, arguments_: Record<string, unknown>, key = 'guid'): void {
  requireObjectId(data, ['actor', 'entity'], arguments_[key], 'Entity', 'guid');
}

function requireAccount(data: unknown, arguments_: Record<string, unknown>): void {
  requireObjectId(data, ['actor', 'account'], arguments_.accountId, 'Account');
}

function requireEntityResult(
  data: unknown,
  arguments_: Record<string, unknown>,
  key = 'guid',
): unknown {
  requireEntity(data, arguments_, key);
  return data;
}

function entityTagValues(data: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const entity = objectAt(data, ['actor', 'entity']);
  const tags = Array.isArray(entity?.tags) ? entity.tags : [];
  return new Map(
    tags.flatMap((tag) => {
      if (tag === null || typeof tag !== 'object') return [];
      const candidate = tag as JsonObject;
      if (typeof candidate.key !== 'string' || !Array.isArray(candidate.values)) return [];
      return [
        [
          candidate.key,
          new Set(candidate.values.filter((value): value is string => typeof value === 'string')),
        ] as const,
      ];
    }),
  );
}

const validateTagsAdded: NonNullable<InternalToolSpec['validateReadback']> = (data, arguments_) => {
  const actual = entityTagValues(data);
  const expected = Array.isArray(arguments_.tags) ? arguments_.tags : [];
  const complete = expected.every((tag) => {
    if (tag === null || typeof tag !== 'object') return false;
    const candidate = tag as JsonObject;
    if (typeof candidate.key !== 'string' || !Array.isArray(candidate.values)) return false;
    const values = actual.get(candidate.key);
    return candidate.values.every((value) => typeof value === 'string' && values?.has(value));
  });
  if (!complete) {
    throw new CapabilityError('upstream_schema', 'Post-write entity tags did not match the add');
  }
};

const validateTagsRemoved: NonNullable<InternalToolSpec['validateReadback']> = (
  data,
  arguments_,
) => {
  const actual = entityTagValues(data);
  const keys = Array.isArray(arguments_.tagKeys) ? arguments_.tagKeys : [];
  if (keys.some((key) => typeof key !== 'string' || actual.has(key))) {
    throw new CapabilityError(
      'upstream_schema',
      'Post-write entity tags still contain a removed key',
    );
  }
};

function requireNestedId(
  path: readonly string[],
  resource: string,
  argumentKey = 'id',
): NonNullable<InternalToolSpec['validatePreRead']> {
  return (data, arguments_) => {
    requireObjectId(data, path, arguments_[argumentKey], resource);
  };
}

function requireNestedIdResult(
  path: readonly string[],
  resource: string,
  argumentKey = 'id',
): NonNullable<InternalToolSpec['mapResult']> {
  return (data, arguments_) => {
    requireObjectId(data, path, arguments_[argumentKey], resource);
    return data;
  };
}

function requireListId(
  path: readonly string[],
  resource: string,
  argumentKey = 'id',
): NonNullable<InternalToolSpec['validatePreRead']> {
  return (data, arguments_) => {
    const expected = arguments_[argumentKey];
    const items = arrayAt(data, path);
    if (
      !items?.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          String((item as JsonObject).id) === String(expected),
      )
    ) {
      notFound(resource, expected);
    }
  };
}

function projectListTarget(
  path: readonly string[],
  argumentKey = 'id',
): NonNullable<InternalToolSpec['projectPreRead']> {
  return (data, arguments_) => {
    const expected = arguments_[argumentKey];
    const target = arrayAt(data, path)?.find(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        String((item as JsonObject).id) === String(expected),
    );
    if (target === undefined) notFound('Pre-read target', expected);
    const accountId = objectAt(data, ['actor', 'account'])?.id;
    return {
      ...(accountId === undefined ? {} : { accountId }),
      target,
    };
  };
}

function requireEntities(data: unknown, requested: unknown, path = ['actor', 'entities']): void {
  const expected = Array.isArray(requested) ? requested.map(String) : [];
  const entities = arrayAt(data, path);
  const found = new Set(
    (entities ?? [])
      .filter((entity): entity is JsonObject => entity !== null && typeof entity === 'object')
      .map((entity) => String(entity.guid)),
  );
  const missing = expected.filter((guid) => !found.has(guid));
  if (entities === undefined || missing.length > 0) {
    throw new CapabilityError('not_found', 'One or more target entities were not found', {
      missingGuids: missing,
    });
  }
}

function requireEveryListId(
  data: unknown,
  path: readonly string[],
  expected: unknown,
  resource: string,
): void {
  const expectedIds = Array.isArray(expected) ? expected.map(String) : [];
  const items = arrayAt(data, path);
  const found = new Set(
    (items ?? [])
      .filter((item): item is JsonObject => item !== null && typeof item === 'object')
      .map((item) => String(item.id)),
  );
  const missing = expectedIds.filter((id) => !found.has(id));
  if (items === undefined || missing.length > 0) {
    throw new CapabilityError('not_found', `${resource} target was not found`, {
      missingIds: missing,
    });
  }
}

function requireAsyncQuery(data: unknown, arguments_: Record<string, unknown>): void {
  const queryProgress = objectAt(data, ['actor', 'account', 'nrqlQueryProgress', 'queryProgress']);
  if (queryProgress === undefined || String(queryProgress.queryId) !== String(arguments_.queryId)) {
    notFound('Asynchronous NRQL query', arguments_.queryId);
  }
}

function requireAsyncQueryResult(data: unknown, arguments_: Record<string, unknown>): unknown {
  requireAsyncQuery(data, arguments_);
  return data;
}

function requireDashboard(data: unknown, arguments_: Record<string, unknown>): void {
  requireObjectId(
    data,
    ['actor', 'entity'],
    arguments_.dashboardGuid ?? arguments_.guid,
    'Dashboard',
    'guid',
  );
}

function requireDashboardPage(data: unknown, arguments_: Record<string, unknown>): void {
  const dashboard = requireObjectId(
    data,
    ['actor', 'entity'],
    arguments_.dashboardGuid,
    'Dashboard',
    'guid',
  );
  const pages = Array.isArray(dashboard.pages) ? dashboard.pages : [];
  if (
    !pages.some(
      (page) =>
        page !== null &&
        typeof page === 'object' &&
        String((page as JsonObject).guid) === String(arguments_.guid),
    )
  ) {
    notFound('Dashboard page', arguments_.guid);
  }
}

function writeInput<Shape extends ZodRawShape>(shape: Shape) {
  return z.object({ ...shape, ...writeControlsSchema }).strict();
}

function read(options: {
  name: string;
  title: string;
  description: string;
  toolset: ToolsetName;
  inputSchema: InternalToolSpec['inputSchema'];
  operation: NerdGraphOperation;
  mapVariables?: InternalToolSpec['mapVariables'];
  requiredEventTypes?: readonly string[];
  fixedNrql?: InternalToolSpec['fixedNrql'];
  mapResult?: InternalToolSpec['mapResult'];
  omitPagination?: boolean;
  requiredScope?: 'newrelic:read' | 'newrelic:admin';
  gate?: 'admin' | 'previewApis';
}): InternalToolSpec {
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    toolset: options.toolset,
    inputSchema: options.inputSchema,
    operation: options.operation,
    requiredScope: options.requiredScope ?? 'newrelic:read',
    ...(options.mapVariables === undefined ? {} : { mapVariables: options.mapVariables }),
    ...(options.requiredEventTypes === undefined
      ? {}
      : { requiredEventTypes: options.requiredEventTypes }),
    ...(options.fixedNrql === undefined ? {} : { fixedNrql: options.fixedNrql }),
    ...(options.mapResult === undefined ? {} : { mapResult: options.mapResult }),
    ...(options.omitPagination === undefined ? {} : { omitPagination: options.omitPagination }),
    ...(options.gate === undefined ? {} : { gate: options.gate }),
  };
}

function write(options: {
  name: string;
  title: string;
  description: string;
  toolset: ToolsetName;
  inputSchema: InternalToolSpec['inputSchema'];
  operation: NerdGraphOperation;
  resolveOperation?: InternalToolSpec['resolveOperation'];
  mapVariables?: InternalToolSpec['mapVariables'];
  preReadOperation?: NerdGraphOperation;
  mapPreReadVariables?: InternalToolSpec['mapPreReadVariables'];
  preReadConnections?: InternalToolSpec['preReadConnections'];
  maxPreReadPages?: number;
  validatePreRead?: InternalToolSpec['validatePreRead'];
  projectPreRead?: InternalToolSpec['projectPreRead'];
  validateReadback?: InternalToolSpec['validateReadback'];
  destructive?: boolean;
  idempotent?: boolean;
  admin?: boolean;
  preview?: boolean;
  experimental?: boolean;
  requiresDestructive?: InternalToolSpec['requiresDestructive'];
}): InternalToolSpec {
  const gates: NonNullable<InternalToolSpec['additionalGates']>[number][] = [];
  if (options.destructive) gates.push('destructive');
  if (options.admin) gates.push('admin');
  if (options.preview) gates.push('previewApis');
  if (options.experimental) gates.push('experimentalAiIssues');
  return {
    name: options.name,
    title: options.title,
    description: `${options.description} Defaults to dry-run and requires the exact returned confirmation phrase to apply.`,
    toolset: options.toolset,
    inputSchema: options.inputSchema,
    operation: options.operation,
    requiredScope: options.admin ? 'newrelic:admin' : 'newrelic:write',
    gate: 'writes',
    ...(gates.length === 0 ? {} : { additionalGates: gates }),
    ...(options.resolveOperation === undefined
      ? {}
      : { resolveOperation: options.resolveOperation }),
    ...(options.mapVariables === undefined ? {} : { mapVariables: options.mapVariables }),
    ...(options.preReadOperation === undefined
      ? {}
      : { preReadOperation: options.preReadOperation }),
    ...(options.mapPreReadVariables === undefined
      ? {}
      : { mapPreReadVariables: options.mapPreReadVariables }),
    ...(options.preReadConnections === undefined
      ? {}
      : { preReadConnections: options.preReadConnections }),
    ...(options.maxPreReadPages === undefined ? {} : { maxPreReadPages: options.maxPreReadPages }),
    ...(options.validatePreRead === undefined ? {} : { validatePreRead: options.validatePreRead }),
    ...(options.projectPreRead === undefined ? {} : { projectPreRead: options.projectPreRead }),
    ...(options.validateReadback === undefined
      ? {}
      : { validateReadback: options.validateReadback }),
    ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
    ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
    ...(options.requiresDestructive === undefined
      ? {}
      : { requiresDestructive: options.requiresDestructive }),
  };
}

const nrqlInput = z
  .object({
    accountId: accountIdSchema.optional(),
    query: z.string().min(1).max(16_384),
  })
  .strict();

function nrqlVariables(arguments_: Record<string, unknown>) {
  return { accountId: arguments_.accountId, nrql: arguments_.query };
}

function telemetryRead(
  name: string,
  title: string,
  description: string,
  requiredEventTypes: readonly string[],
): InternalToolSpec {
  return read({
    name,
    title,
    description,
    toolset: 'nrql',
    inputSchema: nrqlInput,
    operation: NRQL_QUERY,
    mapVariables: nrqlVariables,
    requiredEventTypes,
  });
}

const coreSpecs: InternalToolSpec[] = [
  read({
    name: 'connection_check',
    title: 'Check New Relic connection',
    description: 'Validate the configured user key and return non-secret user/account metadata.',
    toolset: 'core',
    inputSchema: emptyInput,
    operation: CONNECTION_CHECK,
  }),
  read({
    name: 'accounts_list',
    title: 'List accessible accounts',
    description: 'List New Relic accounts visible to the configured user key.',
    toolset: 'core',
    inputSchema: emptyInput,
    operation: ACCOUNTS_LIST,
  }),
];

const telemetrySpecs: InternalToolSpec[] = [
  read({
    name: 'nrql_query',
    title: 'Run a read-only NRQL query',
    description:
      'Run bounded read-only NRQL for one authorized account. Maximum upstream result size is 5,000 rows.',
    toolset: 'nrql',
    inputSchema: nrqlInput,
    operation: NRQL_QUERY,
    mapVariables: nrqlVariables,
  }),
  read({
    name: 'nrql_async_start',
    title: 'Start an asynchronous NRQL query',
    description:
      'Start a long-running read-only NRQL query and return its query progress identifier.',
    toolset: 'nrql',
    inputSchema: nrqlInput,
    operation: NRQL_ASYNC_START,
    mapVariables: nrqlVariables,
  }),
  read({
    name: 'nrql_async_status',
    title: 'Get asynchronous NRQL status',
    description: 'Poll a previously started asynchronous NRQL query.',
    toolset: 'nrql',
    inputSchema: z.object({ accountId: accountIdSchema.optional(), queryId: idSchema }).strict(),
    operation: NRQL_ASYNC_STATUS,
    mapResult: requireAsyncQueryResult,
  }),
  write({
    name: 'nrql_async_cancel',
    title: 'Cancel an asynchronous NRQL query',
    description: 'Cancel a running asynchronous NRQL query.',
    toolset: 'nrql',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), queryId: idSchema }),
    operation: NRQL_ASYNC_CANCEL,
    preReadOperation: NRQL_ASYNC_STATUS,
    mapPreReadVariables: ({ accountId, queryId }) => ({ accountId, queryId }),
    validatePreRead: requireAsyncQuery,
    destructive: true,
  }),
  telemetryRead('logs_query', 'Query logs', 'Run read-only NRQL restricted to Log events.', [
    'Log',
  ]),
  telemetryRead(
    'metrics_query',
    'Query dimensional metrics',
    'Run read-only NRQL restricted to Metric data.',
    ['Metric'],
  ),
  telemetryRead(
    'traces_query',
    'Query trace spans',
    'Run read-only NRQL restricted to Span events.',
    ['Span'],
  ),
  read({
    name: 'trace_get',
    title: 'Get a distributed trace',
    description:
      'Retrieve a complete distributed trace graph, spans, relationships, entities, and anomalies by trace ID.',
    toolset: 'nrql',
    inputSchema: z.object({ traceId: z.string().min(1).max(256) }).strict(),
    operation: TRACE_GET,
    mapResult: requireNestedIdResult(
      ['actor', 'distributedTracing', 'trace'],
      'Distributed trace',
      'traceId',
    ),
  }),
  telemetryRead(
    'errors_query',
    'Query errors',
    'Run read-only NRQL restricted to common New Relic error event types.',
    ['TransactionError', 'JavaScriptError', 'MobileHandledException', 'MobileCrash'],
  ),
];

const tagSchema = z
  .object({ key: z.string().min(1).max(255), values: z.array(z.string().max(255)).min(1).max(100) })
  .strict();
const relationshipType = z.enum([
  'BUILT_FROM',
  'BYPASS_CALLS',
  'CALLS',
  'CONNECTS_TO',
  'CONSUMES',
  'CONTAINS',
  'HOSTS',
  'IS',
  'MANAGES',
  'MEASURES',
  'MONITORS',
  'OPERATES_IN',
  'OWNS',
  'PRODUCES',
  'SERVES',
  'TRIGGERS',
]);

const entitySpecs: InternalToolSpec[] = [
  read({
    name: 'entities_search',
    title: 'Search entities',
    description:
      'Search the New Relic entity platform with cursor pagination, capped at 200 entities per page.',
    toolset: 'entities',
    inputSchema: z
      .object({
        query: z.string().min(1).max(4096),
        cursor: cursorSchema.optional(),
      })
      .strict(),
    operation: ENTITY_SEARCH,
    mapVariables: ({ query, cursor }) => ({ query, cursor }),
  }),
  read({
    name: 'entities_get',
    title: 'Get an entity',
    description: 'Get entity identity, health, reporting, metadata, and tags by GUID.',
    toolset: 'entities',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: ENTITY_GET,
    mapResult: requireEntityResult,
  }),
  read({
    name: 'entity_relationships_list',
    title: 'List entity relationships',
    description:
      "List incoming and outgoing entity relationships, bounded by New Relic's relationship limit.",
    toolset: 'entities',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: ENTITY_RELATIONSHIPS,
    mapResult: requireEntityResult,
  }),
  read({
    name: 'entity_golden_data_get',
    title: 'Get entity golden data',
    description: 'Get effective golden metrics and golden tags for an entity.',
    toolset: 'entities',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: ENTITY_GOLDEN_DATA,
    mapResult: requireEntityResult,
  }),
  write({
    name: 'entity_tags_add',
    title: 'Add entity tags',
    description: 'Add tag values without replacing unrelated tags.',
    toolset: 'entities',
    inputSchema: writeInput({ guid: guidSchema, tags: z.array(tagSchema).min(1).max(100) }),
    operation: MUTATIONS.entityTagsAdd,
    preReadOperation: ENTITY_GET,
    validatePreRead: requireEntity,
    validateReadback: validateTagsAdded,
    idempotent: true,
  }),
  write({
    name: 'entity_tags_remove',
    title: 'Remove entity tags',
    description: 'Remove selected tag keys from an entity.',
    toolset: 'entities',
    inputSchema: writeInput({
      guid: guidSchema,
      tagKeys: z.array(z.string().min(1).max(255)).min(1).max(100),
    }),
    operation: MUTATIONS.entityTagsRemove,
    preReadOperation: ENTITY_GET,
    validatePreRead: requireEntity,
    validateReadback: validateTagsRemoved,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'entity_tags_replace',
    title: 'Replace entity tags',
    description: 'Replace the full tag set for an entity.',
    toolset: 'entities',
    inputSchema: writeInput({ guid: guidSchema, tags: z.array(tagSchema).max(100) }),
    operation: MUTATIONS.entityTagsReplace,
    preReadOperation: ENTITY_GET,
    validatePreRead: requireEntity,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'entity_relationship_put',
    title: 'Create or replace an entity relationship',
    description: 'Create or replace a documented user-defined relationship.',
    toolset: 'entities',
    inputSchema: writeInput({
      sourceGuid: guidSchema,
      targetGuid: guidSchema,
      type: relationshipType,
    }),
    operation: MUTATIONS.entityRelationshipPut,
    preReadOperation: ENTITY_PAIR_GET,
    mapPreReadVariables: ({ sourceGuid, targetGuid }) => ({ sourceGuid, targetGuid }),
    validatePreRead: (data, { sourceGuid, targetGuid }) => {
      requireObjectId(data, ['actor', 'source'], sourceGuid, 'Source entity', 'guid');
      requireObjectId(data, ['actor', 'target'], targetGuid, 'Target entity', 'guid');
    },
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'entity_relationship_delete',
    title: 'Delete an entity relationship',
    description: 'Delete a documented user-defined relationship.',
    toolset: 'entities',
    inputSchema: writeInput({
      sourceGuid: guidSchema,
      targetGuid: guidSchema,
      type: relationshipType,
    }),
    operation: MUTATIONS.entityRelationshipDelete,
    preReadOperation: ENTITY_PAIR_GET,
    mapPreReadVariables: ({ sourceGuid, targetGuid }) => ({ sourceGuid, targetGuid }),
    validatePreRead: (data, { sourceGuid, targetGuid }) => {
      requireObjectId(data, ['actor', 'source'], sourceGuid, 'Source entity', 'guid');
      requireObjectId(data, ['actor', 'target'], targetGuid, 'Target entity', 'guid');
    },
    destructive: true,
    idempotent: true,
  }),
];

const policyInput = z
  .object({
    name: z.string().min(1).max(255),
    incidentPreference: z.enum(['PER_POLICY', 'PER_CONDITION', 'PER_CONDITION_AND_TARGET']),
  })
  .strict();
const nrqlConditionTerm = z
  .object({
    operator: z.enum([
      'ABOVE',
      'ABOVE_OR_EQUALS',
      'BELOW',
      'BELOW_OR_EQUALS',
      'EQUALS',
      'NOT_EQUALS',
    ]),
    priority: z.enum(['CRITICAL', 'WARNING']),
    threshold: z.number().nullable(),
    thresholdDuration: z.number().int().positive(),
    thresholdOccurrences: z.enum(['ALL', 'AT_LEAST_ONCE']),
    prediction: z
      .object({
        predictBy: z.number().int().positive(),
        preferPredictionViolation: z.boolean().optional(),
      })
      .strict()
      .optional(),
    disableHealthStatusReporting: z.boolean().optional(),
    disableEventCreation: z.boolean().optional(),
  })
  .strict();
const nrqlConditionExpiration = z
  .object({
    expirationDuration: z.number().int().positive().nullable().optional(),
    closeViolationsOnExpiration: z.boolean().optional(),
    openViolationOnExpiration: z.boolean().optional(),
    ignoreOnExpectedTermination: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'expiration must not be empty');
const nrqlConditionSignal = z
  .object({
    aggregationWindow: z.number().int().positive().optional(),
    evaluationOffset: z.number().int().nonnegative().optional(),
    evaluationDelay: z.number().int().nonnegative().optional(),
    fillOption: z.enum(['LAST_VALUE', 'NONE', 'STATIC']).nullable().optional(),
    fillValue: z.number().nullable().optional(),
    aggregationMethod: z.enum(['CADENCE', 'EVENT_FLOW', 'EVENT_TIMER']).nullable().optional(),
    aggregationDelay: z.number().int().nonnegative().nullable().optional(),
    aggregationTimer: z.number().int().nonnegative().nullable().optional(),
    slideBy: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'signal must not be empty');
const conditionInput = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    enabled: z.boolean(),
    nrql: z
      .object({
        query: readOnlyConfigurationNrqlSchema,
        dataAccountId: accountIdSchema.optional(),
        evaluationOffset: z.number().int().nonnegative().optional(),
      })
      .strict(),
    runbookUrl: z.string().max(4096).optional(),
    terms: z.array(nrqlConditionTerm).min(1).max(2),
    violationTimeLimitSeconds: z.number().int().positive().optional(),
    expiration: nrqlConditionExpiration.optional(),
    signal: nrqlConditionSignal.optional(),
    titleTemplate: z.string().max(4000).nullable().optional(),
    targetEntity: guidSchema.nullable().optional(),
  })
  .strict();
const conditionUpdateInput = conditionInput
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'condition update must not be empty');
const mutingRuleInput = z
  .object({
    actionOnMutingRuleWindowEnded: z.enum(['ACTIVATE', 'CLOSE_ISSUES']).optional(),
    condition: z
      .object({
        operator: z.enum(['AND', 'OR']),
        conditions: z
          .array(
            z
              .object({
                attribute: z.string().min(1).max(255),
                operator: z.enum([
                  'ANY',
                  'CONTAINS',
                  'ENDS_WITH',
                  'EQUALS',
                  'IN',
                  'IS_BLANK',
                  'IS_NOT_BLANK',
                  'NOT_CONTAINS',
                  'NOT_ENDS_WITH',
                  'NOT_EQUALS',
                  'NOT_IN',
                  'NOT_STARTS_WITH',
                  'STARTS_WITH',
                ]),
                values: z.array(z.string()).max(100),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    description: z.string().max(4000).optional(),
    enabled: z.boolean(),
    name: z.string().min(1).max(255),
    schedule: z
      .object({
        endRepeat: z.string().optional(),
        endTime: z.string().optional(),
        repeat: z.enum(['DAILY', 'MONTHLY', 'WEEKLY']).nullable().optional(),
        repeatCount: z.number().int().positive().optional(),
        startTime: z.string().optional(),
        timeZone: z.string().min(1).max(255),
        weeklyRepeatDays: z
          .array(
            z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']),
          )
          .max(7),
      })
      .strict()
      .superRefine(({ endRepeat, repeatCount, repeat, weeklyRepeatDays }, context) => {
        if (endRepeat !== undefined && repeatCount !== undefined) {
          context.addIssue({
            code: 'custom',
            message: 'endRepeat and repeatCount are mutually exclusive',
          });
        }
        if (repeat === 'WEEKLY' && weeklyRepeatDays.length === 0) {
          context.addIssue({
            code: 'custom',
            path: ['weeklyRepeatDays'],
            message: 'weeklyRepeatDays is required for a weekly schedule',
          });
        }
      })
      .optional(),
  })
  .strict();
const notificationKind = z.enum(['destination', 'channel', 'workflow']);
const notificationProperty = z
  .object({
    key: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) => !/(?:api.?key|token|authorization|password|secret|credential)/iu.test(value),
        'secret-bearing notification properties are not accepted',
      ),
    value: z
      .string()
      .max(16_384)
      .refine(
        (value) => !containsSecretBearingUrl(value),
        'secret-bearing URLs are not accepted in notification properties',
      ),
  })
  .strict();
const notificationDestinationCreate = z
  .object({
    name: z.string().min(1).max(255),
    type: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/^SLACK(?:_LEGACY)?$/iu.test(value), 'Slack requires the New Relic UI'),
    properties: z.array(notificationProperty).max(100).optional(),
  })
  .strict();
const notificationDestinationUpdate = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    properties: z.array(notificationProperty).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'destination update must not be empty');
const notificationChannelCreate = z
  .object({
    destinationId: idSchema,
    name: z.string().min(1).max(255),
    product: z.string().min(1).max(128),
    properties: z.array(notificationProperty).max(100).optional(),
    type: z.string().min(1).max(128),
  })
  .strict();
const notificationChannelUpdate = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    properties: z.array(notificationProperty).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'channel update must not be empty');
const workflowNotificationTrigger = z.enum([
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'ACTIVATED',
  'CLOSED',
  'OTHER_UPDATES',
  'PRIORITY_CHANGED',
]);
const workflowDestination = z
  .object({
    channelId: idSchema,
    notificationTriggers: z.array(workflowNotificationTrigger).min(1).max(6),
    updateOriginalMessage: z.boolean().optional(),
  })
  .strict();
const workflowPredicate = z
  .object({
    attribute: z.string().min(1).max(255),
    operator: z.string().min(1).max(128),
    values: z.array(z.string()).max(100),
  })
  .strict();
const workflowFilter = z
  .object({
    name: z.string().max(255).optional(),
    predicates: z.array(workflowPredicate).max(100).optional(),
    type: z.enum(['FILTER', 'VIEW']),
  })
  .strict();
const workflowNrqlEnrichment = z
  .object({
    id: idSchema.optional(),
    name: z.string().min(1).max(255),
    configuration: z
      .array(z.object({ query: readOnlyConfigurationNrqlSchema }).strict())
      .min(1)
      .max(100),
  })
  .strict();
const workflowEnrichments = z.object({ nrql: z.array(workflowNrqlEnrichment).max(100) }).strict();
const workflowMutingHandling = z.enum([
  'DONT_NOTIFY_FULLY_MUTED_ISSUES',
  'DONT_NOTIFY_FULLY_OR_PARTIALLY_MUTED_ISSUES',
  'NOTIFY_ALL_ISSUES',
]);
const workflowCreate = z
  .object({
    destinationConfigurations: z.array(workflowDestination).max(100).optional(),
    destinationsEnabled: z.boolean(),
    enrichments: workflowEnrichments.optional(),
    enrichmentsEnabled: z.boolean(),
    issuesFilter: workflowFilter,
    mutingRulesHandling: workflowMutingHandling,
    name: z.string().min(1).max(255),
    workflowEnabled: z.boolean(),
  })
  .strict();
const workflowUpdate = z
  .object({
    destinationConfigurations: z.array(workflowDestination).max(100).optional(),
    destinationsEnabled: z.boolean().optional(),
    enrichments: workflowEnrichments.optional(),
    enrichmentsEnabled: z.boolean().optional(),
    issuesFilter: z
      .object({ id: idSchema.optional(), filterInput: workflowFilter })
      .strict()
      .optional(),
    mutingRulesHandling: workflowMutingHandling.optional(),
    name: z.string().min(1).max(255).optional(),
    workflowEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'workflow update must not be empty');
const notificationCreateInput = z.discriminatedUnion('kind', [
  z
    .object({
      accountId: accountIdSchema.optional(),
      kind: z.literal('destination'),
      value: notificationDestinationCreate,
      ...writeControlsSchema,
    })
    .strict(),
  z
    .object({
      accountId: accountIdSchema.optional(),
      kind: z.literal('channel'),
      value: notificationChannelCreate,
      ...writeControlsSchema,
    })
    .strict(),
  z
    .object({
      accountId: accountIdSchema.optional(),
      kind: z.literal('workflow'),
      value: workflowCreate,
      ...writeControlsSchema,
    })
    .strict(),
]);
const notificationUpdateInput = z.discriminatedUnion('kind', [
  z
    .object({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      kind: z.literal('destination'),
      value: notificationDestinationUpdate,
      ...writeControlsSchema,
    })
    .strict(),
  z
    .object({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      kind: z.literal('channel'),
      value: notificationChannelUpdate,
      ...writeControlsSchema,
    })
    .strict(),
  z
    .object({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      kind: z.literal('workflow'),
      value: workflowUpdate,
      ...writeControlsSchema,
    })
    .strict(),
]);

function notificationOperation(action: 'create' | 'update' | 'delete') {
  return (arguments_: Record<string, unknown>): NerdGraphOperation => {
    const kind = arguments_.kind;
    if (action === 'create') {
      if (kind === 'channel') return MUTATIONS.notificationChannelCreate;
      if (kind === 'workflow') return MUTATIONS.notificationWorkflowCreate;
      return MUTATIONS.notificationDestinationCreate;
    }
    if (action === 'update') {
      if (kind === 'channel') return MUTATIONS.notificationChannelUpdate;
      if (kind === 'workflow') return MUTATIONS.notificationWorkflowUpdate;
      return MUTATIONS.notificationDestinationUpdate;
    }
    if (kind === 'channel') return MUTATIONS.notificationChannelDelete;
    if (kind === 'workflow') return MUTATIONS.notificationWorkflowDelete;
    return MUTATIONS.notificationDestinationDelete;
  };
}

function notificationVariables(arguments_: Record<string, unknown>): Record<string, unknown> {
  const { kind, value, ...rest } = arguments_;
  const { id, ...withoutId } = rest;
  if (kind === 'workflow') {
    if (value === undefined) return { ...withoutId, id, deleteChannels: false };
    if (id === undefined) return { ...withoutId, createWorkflowData: value };
    return {
      ...withoutId,
      deleteUnusedChannels: false,
      updateWorkflowData: { ...(value as Record<string, unknown>), id },
    };
  }
  const field = kind === 'channel' ? 'channel' : 'destination';
  const idField = kind === 'channel' ? 'channelId' : 'destinationId';
  return {
    ...withoutId,
    ...(id === undefined ? {} : { [idField]: id }),
    ...(value === undefined ? {} : { [field]: value }),
  };
}

function notificationEntities(data: unknown, kind: unknown): readonly unknown[] | undefined {
  if (kind === 'workflow') {
    return arrayAt(data, ['actor', 'account', 'aiWorkflows', 'workflows', 'entities']);
  }
  return arrayAt(data, [
    'actor',
    'account',
    'aiNotifications',
    kind === 'channel' ? 'channels' : 'destinations',
    'entities',
  ]);
}

function requireNotificationId(
  data: unknown,
  kind: unknown,
  id: unknown,
  resource = 'Notification resource',
): void {
  const entities = notificationEntities(data, kind);
  if (
    !entities?.some(
      (entity) =>
        entity !== null &&
        typeof entity === 'object' &&
        String((entity as JsonObject).id) === String(id),
    )
  ) {
    notFound(resource, id);
  }
}

function requireWorkflowChannels(data: unknown, value: unknown): void {
  const configurations = (value as { destinationConfigurations?: unknown } | undefined)
    ?.destinationConfigurations;
  if (!Array.isArray(configurations)) return;
  for (const configuration of configurations) {
    const channelId = (configuration as { channelId?: unknown } | undefined)?.channelId;
    requireNotificationId(data, 'channel', channelId, 'Notification channel');
  }
}

function notificationEntity(data: unknown, kind: unknown, id: unknown): unknown {
  const target = notificationEntities(data, kind)?.find(
    (entity) =>
      entity !== null &&
      typeof entity === 'object' &&
      String((entity as JsonObject).id) === String(id),
  );
  if (target === undefined) notFound('Notification pre-read target', id);
  return target;
}

const projectNotificationPreRead: NonNullable<InternalToolSpec['projectPreRead']> = (
  data,
  arguments_,
) => {
  const kind = arguments_.kind;
  const targetId = arguments_.channelId ?? arguments_.id;
  const targetKind = arguments_.channelId === undefined ? kind : 'channel';
  const configurations = (arguments_.value as { destinationConfigurations?: unknown } | undefined)
    ?.destinationConfigurations;
  const prerequisiteChannelIds = Array.isArray(configurations)
    ? configurations.map(
        (configuration) => (configuration as { channelId?: unknown } | undefined)?.channelId,
      )
    : [];
  const destinationId =
    kind === 'channel' && arguments_.id === undefined
      ? (arguments_.value as { destinationId?: unknown } | undefined)?.destinationId
      : undefined;
  const accountId = objectAt(data, ['actor', 'account'])?.id;
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(targetId === undefined ? {} : { target: notificationEntity(data, targetKind, targetId) }),
    prerequisites: [
      ...(destinationId === undefined
        ? []
        : [notificationEntity(data, 'destination', destinationId)]),
      ...prerequisiteChannelIds.map((channelId) => notificationEntity(data, 'channel', channelId)),
    ],
  };
};

const incidentListInput = z
  .object({
    accountId: accountIdSchema.optional(),
    since: z
      .string()
      .regex(/^\d+\s+(?:minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/iu)
      .default('24 hours ago'),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();
const escapeNrqlLiteral = (value: unknown) =>
  String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const alertSpecs: InternalToolSpec[] = [
  read({
    name: 'alert_policies_list',
    title: 'List alert policies',
    description: 'List alert policies with cursor pagination.',
    toolset: 'alerts',
    inputSchema: accountPageInput,
    operation: ALERT_POLICIES_LIST,
    mapVariables: ({ accountId, cursor }) => ({ accountId, cursor }),
  }),
  read({
    name: 'alert_policy_get',
    title: 'Get an alert policy',
    description: 'Get an alert policy by ID.',
    toolset: 'alerts',
    inputSchema: z.object({ accountId: accountIdSchema.optional(), id: idSchema }).strict(),
    operation: ALERT_POLICY_GET,
    mapResult: requireNestedIdResult(['actor', 'account', 'alerts', 'policy'], 'Alert policy'),
  }),
  read({
    name: 'alert_conditions_list',
    title: 'List NRQL alert conditions',
    description: 'List NRQL alert conditions, optionally filtered by policy.',
    toolset: 'alerts',
    inputSchema: z
      .object({
        accountId: accountIdSchema.optional(),
        policyId: idSchema.optional(),
        cursor: cursorSchema.optional(),
      })
      .strict(),
    operation: ALERT_CONDITIONS_LIST,
    mapVariables: ({ accountId, policyId, cursor }) => ({ accountId, policyId, cursor }),
  }),
  read({
    name: 'alert_condition_get',
    title: 'Get an NRQL alert condition',
    description: 'Get an NRQL alert condition by ID.',
    toolset: 'alerts',
    inputSchema: z.object({ accountId: accountIdSchema.optional(), id: idSchema }).strict(),
    operation: ALERT_CONDITION_GET,
    mapResult: requireNestedIdResult(
      ['actor', 'account', 'alerts', 'nrqlCondition'],
      'Alert condition',
    ),
  }),
  read({
    name: 'muting_rules_list',
    title: 'List muting rules',
    description: 'List alert muting rules and schedules.',
    toolset: 'alerts',
    inputSchema: accountPageInput,
    operation: MUTING_RULES_LIST,
    mapVariables: ({ accountId, cursor }) => ({ accountId, cursor }),
  }),
  read({
    name: 'notifications_list',
    title: 'List notification resources',
    description: 'List destinations, channels, and workflows without secret values.',
    toolset: 'alerts',
    inputSchema: z
      .object({
        accountId: accountIdSchema.optional(),
        destinationCursor: cursorSchema.optional(),
        channelCursor: cursorSchema.optional(),
        workflowCursor: cursorSchema.optional(),
      })
      .strict(),
    operation: NOTIFICATIONS_LIST,
    omitPagination: true,
  }),
  read({
    name: 'issues_list',
    title: 'List issues',
    description: 'Read stable issue history from NrAiIssue with bounded NRQL.',
    toolset: 'alerts',
    inputSchema: incidentListInput,
    operation: NRQL_QUERY,
    fixedNrql: ({ since, limit }) =>
      `SELECT latest(title), latest(priority), latest(state), latest(entityGuids), latest(updatedAt) FROM NrAiIssue FACET issueId SINCE ${escapeNrqlLiteral(since)} LIMIT ${String(limit)}`,
  }),
  read({
    name: 'incidents_list',
    title: 'List incidents',
    description: 'Read stable incident history from NrAiIncident with bounded NRQL.',
    toolset: 'alerts',
    inputSchema: incidentListInput,
    operation: NRQL_QUERY,
    fixedNrql: ({ since, limit }) =>
      `SELECT latest(title), latest(priority), latest(state), latest(entityGuid), latest(updatedAt) FROM NrAiIncident FACET incidentId SINCE ${escapeNrqlLiteral(since)} LIMIT ${String(limit)}`,
  }),
  write({
    name: 'alert_policy_create',
    title: 'Create an alert policy',
    description: 'Create an alert policy.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), policy: policyInput }),
    operation: MUTATIONS.alertPolicyCreate,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'alert_policy_update',
    title: 'Update an alert policy',
    description: 'Partially update an alert policy.',
    toolset: 'alerts',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      policy: policyInput.partial(),
    }),
    operation: MUTATIONS.alertPolicyUpdate,
    preReadOperation: ALERT_POLICY_GET,
    validatePreRead: requireNestedId(['actor', 'account', 'alerts', 'policy'], 'Alert policy'),
  }),
  write({
    name: 'alert_policy_delete',
    title: 'Delete an alert policy',
    description: 'Delete an alert policy.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), id: idSchema }),
    operation: MUTATIONS.alertPolicyDelete,
    preReadOperation: ALERT_POLICY_GET,
    validatePreRead: requireNestedId(['actor', 'account', 'alerts', 'policy'], 'Alert policy'),
    destructive: true,
  }),
  write({
    name: 'alert_condition_create',
    title: 'Create an NRQL alert condition',
    description: 'Create a static NRQL alert condition.',
    toolset: 'alerts',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      policyId: idSchema,
      condition: conditionInput,
    }),
    operation: MUTATIONS.alertConditionCreate,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'alert_condition_update',
    title: 'Update an NRQL alert condition',
    description: 'Update a static NRQL alert condition.',
    toolset: 'alerts',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      condition: conditionUpdateInput,
    }),
    operation: MUTATIONS.alertConditionUpdate,
    preReadOperation: ALERT_CONDITION_GET,
    validatePreRead: requireNestedId(
      ['actor', 'account', 'alerts', 'nrqlCondition'],
      'Alert condition',
    ),
  }),
  write({
    name: 'alert_condition_delete',
    title: 'Delete an alert condition',
    description: 'Delete an alert condition.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), id: idSchema }),
    operation: MUTATIONS.alertConditionDelete,
    preReadOperation: ALERT_CONDITION_GET,
    validatePreRead: requireNestedId(
      ['actor', 'account', 'alerts', 'nrqlCondition'],
      'Alert condition',
    ),
    destructive: true,
  }),
  write({
    name: 'muting_rule_create',
    title: 'Create a muting rule',
    description: 'Create a muting rule and schedule.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), rule: mutingRuleInput }),
    operation: MUTATIONS.mutingRuleCreate,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'muting_rule_update',
    title: 'Update a muting rule',
    description: 'Update a muting rule; schedule changes may replace existing schedule fields.',
    toolset: 'alerts',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      rule: mutingRuleInput,
    }),
    operation: MUTATIONS.mutingRuleUpdate,
    preReadOperation: MUTING_RULES_LIST,
    mapPreReadVariables: ({ accountId }) => ({ accountId }),
    preReadConnections: [
      {
        cursorVariable: 'cursor',
        path: ['actor', 'account', 'alerts', 'mutingRules'],
      },
    ],
    validatePreRead: requireListId(
      ['actor', 'account', 'alerts', 'mutingRules', 'rules'],
      'Muting rule',
    ),
    projectPreRead: projectListTarget(['actor', 'account', 'alerts', 'mutingRules', 'rules']),
    destructive: true,
  }),
  write({
    name: 'muting_rule_delete',
    title: 'Delete a muting rule',
    description: 'Delete a muting rule.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), id: idSchema }),
    operation: MUTATIONS.mutingRuleDelete,
    preReadOperation: MUTING_RULES_LIST,
    mapPreReadVariables: ({ accountId }) => ({ accountId }),
    preReadConnections: [
      {
        cursorVariable: 'cursor',
        path: ['actor', 'account', 'alerts', 'mutingRules'],
      },
    ],
    validatePreRead: requireListId(
      ['actor', 'account', 'alerts', 'mutingRules', 'rules'],
      'Muting rule',
    ),
    projectPreRead: projectListTarget(['actor', 'account', 'alerts', 'mutingRules', 'rules']),
    destructive: true,
  }),
  write({
    name: 'notification_create',
    title: 'Create a notification resource',
    description:
      'Create a destination, channel, or workflow. Slack destinations are explicitly rejected.',
    toolset: 'alerts',
    inputSchema: notificationCreateInput,
    operation: MUTATIONS.notificationDestinationCreate,
    resolveOperation: notificationOperation('create'),
    mapVariables: notificationVariables,
    preReadOperation: NOTIFICATIONS_LIST,
    preReadConnections: [
      {
        cursorVariable: 'destinationCursor',
        path: ['actor', 'account', 'aiNotifications', 'destinations'],
      },
      {
        cursorVariable: 'channelCursor',
        path: ['actor', 'account', 'aiNotifications', 'channels'],
      },
      {
        cursorVariable: 'workflowCursor',
        path: ['actor', 'account', 'aiWorkflows', 'workflows'],
      },
    ],
    validatePreRead: (data, arguments_) => {
      requireAccount(data, arguments_);
      const { kind, value } = arguments_;
      if (kind === 'channel') {
        requireNotificationId(
          data,
          'destination',
          (value as { destinationId?: unknown } | undefined)?.destinationId,
          'Notification destination',
        );
      } else if (kind === 'workflow') {
        requireWorkflowChannels(data, value);
      }
    },
    projectPreRead: projectNotificationPreRead,
  }),
  write({
    name: 'notification_update',
    title: 'Update a notification resource',
    description:
      'Update a destination, channel, or workflow. Slack destinations are explicitly rejected.',
    toolset: 'alerts',
    inputSchema: notificationUpdateInput,
    operation: MUTATIONS.notificationDestinationUpdate,
    resolveOperation: notificationOperation('update'),
    mapVariables: notificationVariables,
    preReadOperation: NOTIFICATIONS_LIST,
    preReadConnections: [
      {
        cursorVariable: 'destinationCursor',
        path: ['actor', 'account', 'aiNotifications', 'destinations'],
      },
      {
        cursorVariable: 'channelCursor',
        path: ['actor', 'account', 'aiNotifications', 'channels'],
      },
      {
        cursorVariable: 'workflowCursor',
        path: ['actor', 'account', 'aiWorkflows', 'workflows'],
      },
    ],
    validatePreRead: (data, { kind, id, value }) => {
      requireNotificationId(data, kind, id);
      if (kind === 'workflow') requireWorkflowChannels(data, value);
    },
    projectPreRead: projectNotificationPreRead,
    destructive: true,
  }),
  write({
    name: 'notification_delete',
    title: 'Delete a notification resource',
    description: 'Delete a destination, channel, or workflow.',
    toolset: 'alerts',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      kind: notificationKind,
    }),
    operation: MUTATIONS.notificationDestinationDelete,
    resolveOperation: notificationOperation('delete'),
    mapVariables: notificationVariables,
    preReadOperation: NOTIFICATIONS_LIST,
    preReadConnections: [
      {
        cursorVariable: 'destinationCursor',
        path: ['actor', 'account', 'aiNotifications', 'destinations'],
      },
      {
        cursorVariable: 'channelCursor',
        path: ['actor', 'account', 'aiNotifications', 'channels'],
      },
      {
        cursorVariable: 'workflowCursor',
        path: ['actor', 'account', 'aiWorkflows', 'workflows'],
      },
    ],
    validatePreRead: (data, { kind, id }) => {
      requireNotificationId(data, kind, id);
    },
    projectPreRead: projectNotificationPreRead,
    destructive: true,
  }),
  write({
    name: 'notification_test',
    title: 'Test a notification channel',
    description: 'Send a test notification through a configured channel.',
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), channelId: idSchema }),
    operation: MUTATIONS.notificationTest,
    preReadOperation: NOTIFICATIONS_LIST,
    preReadConnections: [
      {
        cursorVariable: 'destinationCursor',
        path: ['actor', 'account', 'aiNotifications', 'destinations'],
      },
      {
        cursorVariable: 'channelCursor',
        path: ['actor', 'account', 'aiNotifications', 'channels'],
      },
      {
        cursorVariable: 'workflowCursor',
        path: ['actor', 'account', 'aiWorkflows', 'workflows'],
      },
    ],
    validatePreRead: (data, { channelId }) => {
      requireNotificationId(data, 'channel', channelId, 'Notification channel');
    },
    projectPreRead: projectNotificationPreRead,
  }),
  write({
    name: 'issue_acknowledge',
    title: 'Acknowledge an issue',
    description: "Acknowledge an issue through New Relic's experimental AiIssues API.",
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), issueId: idSchema }),
    operation: MUTATIONS.issueAcknowledge,
    experimental: true,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'issue_unacknowledge',
    title: 'Unacknowledge an issue',
    description: "Unacknowledge an issue through New Relic's experimental AiIssues API.",
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), issueId: idSchema }),
    operation: MUTATIONS.issueUnacknowledge,
    experimental: true,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'issue_resolve',
    title: 'Resolve an issue',
    description: "Resolve an issue through New Relic's experimental AiIssues API.",
    toolset: 'alerts',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), issueId: idSchema }),
    operation: MUTATIONS.issueResolve,
    experimental: true,
    validatePreRead: requireAccount,
    destructive: true,
  }),
];

const dashboardSpecs: InternalToolSpec[] = [
  read({
    name: 'dashboards_list',
    title: 'List dashboards',
    description: 'List dashboard entities in an account with cursor pagination.',
    toolset: 'dashboards',
    inputSchema: accountPageInput,
    operation: DASHBOARDS_LIST,
    mapVariables: ({ accountId, cursor }) => ({
      query: `type = 'DASHBOARD' AND accountId = ${String(accountId)}`,
      cursor,
    }),
  }),
  read({
    name: 'dashboard_get',
    title: 'Get a dashboard',
    description: 'Get a complete dashboard definition by GUID, excluding live-sharing secrets.',
    toolset: 'dashboards',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: DASHBOARD_GET,
    mapResult: requireEntityResult,
  }),
  write({
    name: 'dashboard_create',
    title: 'Create a dashboard',
    description:
      'Create a dashboard with at least one page. Any permission other than PRIVATE requires the destructive gate.',
    toolset: 'dashboards',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      dashboard: dashboardInputSchema,
    }),
    operation: MUTATIONS.dashboardCreate,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
    requiresDestructive: ({ dashboard }) =>
      (dashboard as { permissions?: unknown } | undefined)?.permissions !== 'PRIVATE',
  }),
  write({
    name: 'dashboard_update',
    title: 'Replace a dashboard',
    description:
      'Replace a dashboard definition. Omitted pages, widgets, and variables are removed.',
    toolset: 'dashboards',
    inputSchema: writeInput({ guid: guidSchema, dashboard: dashboardInputSchema }),
    operation: MUTATIONS.dashboardUpdate,
    preReadOperation: DASHBOARD_GET,
    validatePreRead: requireDashboard,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'dashboard_page_update',
    title: 'Update dashboard pages',
    description: 'Replace one complete dashboard page by page GUID.',
    toolset: 'dashboards',
    inputSchema: writeInput({
      dashboardGuid: guidSchema,
      guid: guidSchema,
      page: z
        .object({
          name: z.string().min(1).max(255),
          description: z.string().max(4000).optional(),
          widgets: z
            .array(z.record(z.string(), z.unknown()))
            .max(1000)
            .superRefine(validateDashboardNrql),
        })
        .strict()
        .superRefine(validateDashboardNrql),
    }),
    operation: MUTATIONS.dashboardPageUpdate,
    preReadOperation: DASHBOARD_GET,
    mapPreReadVariables: ({ dashboardGuid }) => ({ guid: dashboardGuid }),
    validatePreRead: requireDashboardPage,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'dashboard_widgets_update',
    title: 'Update dashboard widgets',
    description: 'Update existing widgets in one dashboard page by page GUID.',
    toolset: 'dashboards',
    inputSchema: writeInput({
      dashboardGuid: guidSchema,
      guid: guidSchema,
      widgets: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(1000)
        .superRefine(validateDashboardNrql),
    }),
    operation: MUTATIONS.dashboardWidgetsUpdate,
    preReadOperation: DASHBOARD_GET,
    mapPreReadVariables: ({ dashboardGuid }) => ({ guid: dashboardGuid }),
    validatePreRead: requireDashboardPage,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'dashboard_delete',
    title: 'Delete a dashboard',
    description: 'Soft-delete a dashboard by GUID.',
    toolset: 'dashboards',
    inputSchema: writeInput({ guid: guidSchema }),
    operation: MUTATIONS.dashboardDelete,
    preReadOperation: DASHBOARD_GET,
    validatePreRead: requireDashboard,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'dashboard_undelete',
    title: 'Undelete a dashboard',
    description: 'Restore a soft-deleted dashboard by GUID.',
    toolset: 'dashboards',
    inputSchema: writeInput({ guid: guidSchema }),
    operation: MUTATIONS.dashboardUndelete,
    preReadOperation: DASHBOARD_GET,
    validatePreRead: requireDashboard,
    destructive: true,
    idempotent: true,
  }),
];

const syntheticMonitorType = z.enum([
  'ping',
  'simple-browser',
  'scripted-browser',
  'scripted-api',
  'step',
  'certificate-check',
  'broken-link',
]);
const syntheticMonitorPeriod = z.enum([
  'EVERY_MINUTE',
  'EVERY_5_MINUTES',
  'EVERY_10_MINUTES',
  'EVERY_15_MINUTES',
  'EVERY_30_MINUTES',
  'EVERY_HOUR',
  'EVERY_6_HOURS',
  'EVERY_12_HOURS',
  'EVERY_DAY',
]);
const syntheticMonitorStatus = z.enum(['ENABLED', 'DISABLED']);
const syntheticBrowser = z.enum(['CHROME', 'FIREFOX']);
const syntheticDevice = z.enum([
  'DESKTOP',
  'MOBILE_LANDSCAPE',
  'MOBILE_PORTRAIT',
  'TABLET_LANDSCAPE',
  'TABLET_PORTRAIT',
]);
const syntheticTag = z
  .object({
    key: z.string().min(1).max(255),
    values: z.array(z.string().max(255)).min(1).max(100),
  })
  .strict();
const standardLocations = z
  .object({
    public: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
    private: z.array(guidSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    ({ public: publicLocations, private: privateLocations }) =>
      publicLocations !== undefined || privateLocations !== undefined,
    'at least one public or private location is required',
  );
const scriptedLocations = z
  .object({
    public: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
    private: z
      .array(z.object({ guid: guidSchema }).strict())
      .min(1)
      .max(100)
      .optional()
      .describe('VSE passwords are intentionally unsupported; use a non-VSE location'),
  })
  .strict()
  .refine(
    ({ public: publicLocations, private: privateLocations }) =>
      publicLocations !== undefined || privateLocations !== undefined,
    'at least one public or private location is required',
  );
const browserRuntime = z
  .object({
    runtimeType: z.literal('CHROME_BROWSER'),
    runtimeTypeVersion: z.string().min(1).max(64),
    scriptLanguage: z.literal('JAVASCRIPT'),
  })
  .strict();
const stepRuntime = browserRuntime.omit({ scriptLanguage: true });
const apiRuntime = z
  .object({
    runtimeType: z.literal('NODE_API'),
    runtimeTypeVersion: z.string().min(1).max(64),
    scriptLanguage: z.literal('JAVASCRIPT'),
  })
  .strict();
const nodeRuntime = apiRuntime.omit({ scriptLanguage: true });
const customHeader = z
  .object({ name: z.string().min(1).max(255), value: z.string().max(8192) })
  .strict();
const deviceEmulation = z
  .object({
    deviceType: z.enum(['MOBILE', 'TABLET', 'NONE']),
    deviceOrientation: z.enum(['LANDSCAPE', 'PORTRAIT', 'NONE']),
  })
  .strict();
const simpleAdvancedOptions = z
  .object({
    customHeaders: z.array(customHeader).max(100).optional(),
    redirectIsFailure: z.boolean().optional(),
    responseValidationText: z.string().max(16_384).optional(),
    shouldBypassHeadRequest: z.boolean().optional(),
    useTlsValidation: z.boolean().optional(),
  })
  .strict();
const simpleBrowserAdvancedOptions = z
  .object({
    customHeaders: z.array(customHeader).max(100).optional(),
    deviceEmulation: deviceEmulation.optional(),
    enableScreenshotOnFailureAndScript: z.boolean().optional(),
    responseValidationText: z.string().max(16_384).optional(),
    useTlsValidation: z.boolean().optional(),
  })
  .strict();
const scriptBrowserAdvancedOptions = z
  .object({
    deviceEmulation: deviceEmulation.optional(),
    enableScreenshotOnFailureAndScript: z.boolean().optional(),
  })
  .strict();
const stepAdvancedOptions = z
  .object({ enableScreenshotOnFailureAndScript: z.boolean().optional() })
  .strict();
const syntheticStep = z
  .object({
    ordinal: z.number().int().min(0).max(99),
    type: z.enum([
      'ASSERT_ELEMENT',
      'ASSERT_MODAL',
      'ASSERT_TEXT',
      'ASSERT_TITLE',
      'CLICK_ELEMENT',
      'DISMISS_MODAL',
      'DOUBLE_CLICK_ELEMENT',
      'HOVER_ELEMENT',
      'NAVIGATE',
      'SECURE_TEXT_ENTRY',
      'SELECT_ELEMENT',
      'TEXT_ENTRY',
    ]),
    values: z.array(z.string().max(16_384)).max(100),
  })
  .strict();

const commonSyntheticFields = {
  name: z.string().min(1).max(255),
  period: syntheticMonitorPeriod,
  status: syntheticMonitorStatus,
  apdexTarget: z.number().positive().optional(),
  tags: z.array(syntheticTag).max(100).optional(),
};
const browserSyntheticFields = {
  browsers: z.array(syntheticBrowser).min(1).max(10),
  devices: z.array(syntheticDevice).min(1).max(10),
};
const pingMonitor = z
  .object({
    ...commonSyntheticFields,
    locations: standardLocations,
    uri: z.url().max(4096),
    advancedOptions: simpleAdvancedOptions.optional(),
  })
  .strict();
const simpleBrowserMonitor = z
  .object({
    ...commonSyntheticFields,
    ...browserSyntheticFields,
    locations: standardLocations,
    runtime: browserRuntime,
    uri: z.url().max(4096),
    advancedOptions: simpleBrowserAdvancedOptions.optional(),
  })
  .strict();
const scriptBrowserMonitor = z
  .object({
    ...commonSyntheticFields,
    ...browserSyntheticFields,
    locations: scriptedLocations,
    runtime: browserRuntime,
    script: z.string().min(1).max(1_000_000),
    advancedOptions: scriptBrowserAdvancedOptions.optional(),
  })
  .strict();
const scriptApiMonitor = z
  .object({
    ...commonSyntheticFields,
    locations: scriptedLocations,
    runtime: apiRuntime,
    script: z.string().min(1).max(1_000_000),
  })
  .strict();
const stepMonitor = z
  .object({
    ...commonSyntheticFields,
    ...browserSyntheticFields,
    locations: scriptedLocations,
    runtime: stepRuntime,
    steps: z.array(syntheticStep).min(1).max(100),
    advancedOptions: stepAdvancedOptions.optional(),
  })
  .strict();
const certificateMonitor = z
  .object({
    ...commonSyntheticFields,
    locations: standardLocations,
    domain: z.string().min(1).max(2048),
    numberDaysToFailBeforeCertExpires: z.number().int().positive().max(3650),
    runtime: nodeRuntime.optional(),
  })
  .strict();
const brokenLinkMonitor = z
  .object({
    ...commonSyntheticFields,
    locations: standardLocations,
    uri: z.url().max(4096),
    runtime: nodeRuntime.optional(),
  })
  .strict();

function syntheticCreateBranch(
  monitorType: z.infer<typeof syntheticMonitorType>,
  monitor: z.ZodType,
) {
  return z
    .object({
      accountId: accountIdSchema.optional(),
      monitorType: z.literal(monitorType),
      monitor,
      ...writeControlsSchema,
    })
    .strict();
}

function nonEmptyMonitorUpdate<T extends ZodRawShape>(monitor: z.ZodObject<T>) {
  return monitor
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'monitor update must not be empty');
}

function syntheticUpdateBranch(
  monitorType: z.infer<typeof syntheticMonitorType>,
  monitor: z.ZodType,
) {
  return z
    .object({
      guid: guidSchema,
      monitorType: z.literal(monitorType),
      monitor,
      ...writeControlsSchema,
    })
    .strict();
}

const syntheticMonitorCreateInput = z.union([
  syntheticCreateBranch('ping', pingMonitor),
  syntheticCreateBranch('simple-browser', simpleBrowserMonitor),
  syntheticCreateBranch('scripted-browser', scriptBrowserMonitor),
  syntheticCreateBranch('scripted-api', scriptApiMonitor),
  syntheticCreateBranch('step', stepMonitor),
  syntheticCreateBranch('certificate-check', certificateMonitor),
  syntheticCreateBranch('broken-link', brokenLinkMonitor),
]);
const syntheticMonitorUpdateInput = z.union([
  syntheticUpdateBranch('ping', nonEmptyMonitorUpdate(pingMonitor)),
  syntheticUpdateBranch('simple-browser', nonEmptyMonitorUpdate(simpleBrowserMonitor)),
  syntheticUpdateBranch('scripted-browser', nonEmptyMonitorUpdate(scriptBrowserMonitor)),
  syntheticUpdateBranch('scripted-api', nonEmptyMonitorUpdate(scriptApiMonitor)),
  syntheticUpdateBranch('step', nonEmptyMonitorUpdate(stepMonitor)),
  syntheticUpdateBranch('certificate-check', nonEmptyMonitorUpdate(certificateMonitor)),
  syntheticUpdateBranch('broken-link', nonEmptyMonitorUpdate(brokenLinkMonitor)),
]);

const syntheticCreateOperations: Record<
  z.infer<typeof syntheticMonitorType>,
  NerdGraphOperation
> = {
  ping: MUTATIONS.syntheticSimpleCreate,
  'simple-browser': MUTATIONS.syntheticSimpleBrowserCreate,
  'scripted-browser': MUTATIONS.syntheticScriptBrowserCreate,
  'scripted-api': MUTATIONS.syntheticScriptApiCreate,
  step: MUTATIONS.syntheticStepCreate,
  'certificate-check': MUTATIONS.syntheticCertificateCreate,
  'broken-link': MUTATIONS.syntheticBrokenLinkCreate,
};
const syntheticUpdateOperations: Record<
  z.infer<typeof syntheticMonitorType>,
  NerdGraphOperation
> = {
  ping: MUTATIONS.syntheticSimpleUpdate,
  'simple-browser': MUTATIONS.syntheticSimpleBrowserUpdate,
  'scripted-browser': MUTATIONS.syntheticScriptBrowserUpdate,
  'scripted-api': MUTATIONS.syntheticScriptApiUpdate,
  step: MUTATIONS.syntheticStepUpdate,
  'certificate-check': MUTATIONS.syntheticCertificateUpdate,
  'broken-link': MUTATIONS.syntheticBrokenLinkUpdate,
};
const syntheticOperation =
  (operations: typeof syntheticCreateOperations) => (arguments_: Record<string, unknown>) =>
    operations[syntheticMonitorType.parse(arguments_.monitorType)];
const syntheticVariables = ({
  monitorType: _monitorType,
  ...arguments_
}: Record<string, unknown>) => arguments_;
const syntheticSearchVariables =
  (type: 'MONITOR' | 'PRIVATE_LOCATION' | 'MONITOR_DOWNTIME' | 'SECURE_CRED') =>
  ({ accountId, cursor }: Record<string, unknown>) => ({
    query: `domain = 'SYNTH' AND type = '${type}' AND accountId = ${String(accountIdSchema.parse(accountId))}`,
    cursor,
  });

const privateLocationCreateInput = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    shared: z.boolean().optional(),
    verifiedScriptExecution: z.boolean(),
  })
  .strict();
const privateLocationUpdateInput = privateLocationCreateInput
  .omit({ name: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'private location update must not be empty');
const privateLocationVariables = ({ privateLocation, ...rest }: Record<string, unknown>) => ({
  ...rest,
  ...(privateLocation as Record<string, unknown>),
});

const naiveDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u);
const downtimeEndRepeat = z
  .object({ onDate: naiveDateTime.optional(), onRepeat: z.number().int().positive().optional() })
  .strict()
  .refine(
    ({ onDate, onRepeat }) => (onDate === undefined) !== (onRepeat === undefined),
    'exactly one of onDate or onRepeat is required',
  );
const downtimeWeekday = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);
const downtimeMonthlyFrequency = z.union([
  z.object({ daysOfMonth: z.array(z.number().int().min(1).max(31)).min(1).max(31) }).strict(),
  z
    .object({
      daysOfWeek: z
        .object({
          ordinalDayOfMonth: z.enum(['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'LAST']),
          weekDay: downtimeWeekday,
        })
        .strict(),
    })
    .strict(),
]);
const downtimeBase = {
  name: z.string().min(1).max(255),
  monitorGuids: z.array(guidSchema).min(1).max(25),
  timezone: z.string().min(1).max(255),
  startTime: naiveDateTime,
  endTime: naiveDateTime,
};
const downtimeScheduleType = z.enum(['once', 'daily', 'weekly', 'monthly']);
const downtimeOnce = z.object(downtimeBase).strict();
const downtimeDaily = z
  .object({ ...downtimeBase, endRepeat: downtimeEndRepeat.optional() })
  .strict();
const downtimeWeekly = z
  .object({
    ...downtimeBase,
    endRepeat: downtimeEndRepeat.optional(),
    maintenanceDays: z.array(downtimeWeekday).min(1).max(7),
  })
  .strict();
const downtimeMonthly = z
  .object({
    ...downtimeBase,
    endRepeat: downtimeEndRepeat.optional(),
    frequency: downtimeMonthlyFrequency,
  })
  .strict();
const downtimeWriteControls = {
  accountId: accountIdSchema.optional(),
  ...writeControlsSchema,
};
const downtimeCreateToolInput = z.union([
  z
    .object({ ...downtimeWriteControls, scheduleType: z.literal('once'), downtime: downtimeOnce })
    .strict(),
  z
    .object({ ...downtimeWriteControls, scheduleType: z.literal('daily'), downtime: downtimeDaily })
    .strict(),
  z
    .object({
      ...downtimeWriteControls,
      scheduleType: z.literal('weekly'),
      downtime: downtimeWeekly,
    })
    .strict(),
  z
    .object({
      ...downtimeWriteControls,
      scheduleType: z.literal('monthly'),
      downtime: downtimeMonthly,
    })
    .strict(),
]);
const syntheticDowntimeCreateOperations: Record<
  z.infer<typeof downtimeScheduleType>,
  NerdGraphOperation
> = {
  once: MUTATIONS.syntheticDowntimeOnceCreate,
  daily: MUTATIONS.syntheticDowntimeDailyCreate,
  weekly: MUTATIONS.syntheticDowntimeWeeklyCreate,
  monthly: MUTATIONS.syntheticDowntimeMonthlyCreate,
};
const downtimeCreateVariables = ({
  scheduleType: _scheduleType,
  downtime,
  ...rest
}: Record<string, unknown>) => ({
  ...rest,
  ...(downtime as Record<string, unknown>),
});
const downtimeUpdateBase = {
  accountId: accountIdSchema.optional(),
  guid: guidSchema,
  name: z.string().min(1).max(255).optional(),
  monitorGuids: z.array(guidSchema).min(1).max(25).optional(),
  ...writeControlsSchema,
};
const downtimeUpdateToolInput = z.union([
  z
    .object({
      ...downtimeUpdateBase,
      scheduleType: z.literal('once'),
      schedule: downtimeOnce.omit({ name: true, monitorGuids: true }),
    })
    .strict(),
  z
    .object({
      ...downtimeUpdateBase,
      scheduleType: z.literal('daily'),
      schedule: downtimeDaily.omit({ name: true, monitorGuids: true }),
    })
    .strict(),
  z
    .object({
      ...downtimeUpdateBase,
      scheduleType: z.literal('weekly'),
      schedule: downtimeWeekly.omit({ name: true, monitorGuids: true }),
    })
    .strict(),
  z
    .object({
      ...downtimeUpdateBase,
      scheduleType: z.literal('monthly'),
      schedule: downtimeMonthly.omit({ name: true, monitorGuids: true }),
    })
    .strict(),
]);
const downtimeUpdateVariables = ({ scheduleType, schedule, ...rest }: Record<string, unknown>) => ({
  ...rest,
  [String(scheduleType)]: schedule,
});

const syntheticSpecs: InternalToolSpec[] = [
  read({
    name: 'synthetic_monitors_list',
    title: 'List synthetic monitors',
    description: 'List synthetic monitors and non-secret configuration metadata.',
    toolset: 'synthetics',
    inputSchema: accountPageInput,
    operation: SYNTHETIC_MONITORS_LIST,
    mapVariables: syntheticSearchVariables('MONITOR'),
  }),
  read({
    name: 'synthetic_monitor_get',
    title: 'Get a synthetic monitor',
    description: 'Get a monitor summary by entity GUID without secure credential values.',
    toolset: 'synthetics',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: SYNTHETIC_MONITOR_GET,
    mapResult: requireEntityResult,
  }),
  read({
    name: 'synthetic_locations_list',
    title: 'List synthetic locations',
    description:
      'List private synthetic location metadata. Public location identifiers are configured on monitors.',
    toolset: 'synthetics',
    inputSchema: accountPageInput,
    operation: SYNTHETIC_LOCATIONS_LIST,
    mapVariables: syntheticSearchVariables('PRIVATE_LOCATION'),
  }),
  read({
    name: 'synthetic_downtimes_list',
    title: 'List synthetic downtimes',
    description: 'List configured monitor downtime schedules.',
    toolset: 'synthetics',
    inputSchema: accountPageInput,
    operation: SYNTHETIC_DOWNTIMES_LIST,
    mapVariables: syntheticSearchVariables('MONITOR_DOWNTIME'),
  }),
  read({
    name: 'synthetic_secure_credentials_list',
    title: 'List synthetic secure credential metadata',
    description: 'List secure credential entity metadata. Secret values are never queried.',
    toolset: 'synthetics',
    inputSchema: accountPageInput,
    operation: SYNTHETIC_SECURE_CREDENTIALS_LIST,
    mapVariables: syntheticSearchVariables('SECURE_CRED'),
  }),
  write({
    name: 'synthetic_monitor_create',
    title: 'Create a synthetic monitor',
    description:
      'Create a ping, simple-browser, scripted-browser, scripted-API, step, certificate-check, or broken-link monitor.',
    toolset: 'synthetics',
    inputSchema: syntheticMonitorCreateInput,
    operation: MUTATIONS.syntheticSimpleCreate,
    resolveOperation: syntheticOperation(syntheticCreateOperations),
    mapVariables: syntheticVariables,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'synthetic_monitor_update',
    title: 'Update a synthetic monitor',
    description: 'Update a typed synthetic monitor definition.',
    toolset: 'synthetics',
    inputSchema: syntheticMonitorUpdateInput,
    operation: MUTATIONS.syntheticSimpleUpdate,
    resolveOperation: syntheticOperation(syntheticUpdateOperations),
    mapVariables: syntheticVariables,
    preReadOperation: SYNTHETIC_MONITOR_GET,
    validatePreRead: requireEntity,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'synthetic_monitor_delete',
    title: 'Delete a synthetic monitor',
    description: 'Delete a synthetic monitor by GUID.',
    toolset: 'synthetics',
    inputSchema: writeInput({ guid: guidSchema }),
    operation: MUTATIONS.syntheticMonitorDelete,
    preReadOperation: SYNTHETIC_MONITOR_GET,
    validatePreRead: requireEntity,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'synthetic_private_location_create',
    title: 'Create a private synthetic location',
    description: 'Create private-location metadata. Runtime keys remain managed by New Relic.',
    toolset: 'synthetics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      privateLocation: privateLocationCreateInput,
    }),
    operation: MUTATIONS.syntheticPrivateLocationCreate,
    mapVariables: privateLocationVariables,
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'synthetic_private_location_update',
    title: 'Update a private synthetic location',
    description: 'Update private-location metadata.',
    toolset: 'synthetics',
    inputSchema: writeInput({
      guid: guidSchema,
      accountId: accountIdSchema.optional(),
      privateLocation: privateLocationUpdateInput,
    }),
    operation: MUTATIONS.syntheticPrivateLocationUpdate,
    mapVariables: privateLocationVariables,
    preReadOperation: ENTITY_GET,
    mapPreReadVariables: ({ guid }) => ({ guid }),
    validatePreRead: requireEntity,
    destructive: true,
  }),
  write({
    name: 'synthetic_private_location_delete',
    title: 'Delete a private synthetic location',
    description: 'Delete a private synthetic location.',
    toolset: 'synthetics',
    inputSchema: writeInput({ guid: guidSchema, accountId: accountIdSchema.optional() }),
    operation: MUTATIONS.syntheticPrivateLocationDelete,
    preReadOperation: ENTITY_GET,
    mapPreReadVariables: ({ guid }) => ({ guid }),
    validatePreRead: requireEntity,
    destructive: true,
  }),
  write({
    name: 'synthetic_downtime_create',
    title: 'Create synthetic monitor downtime',
    description: 'Create a monitor downtime schedule.',
    toolset: 'synthetics',
    inputSchema: downtimeCreateToolInput,
    operation: MUTATIONS.syntheticDowntimeOnceCreate,
    resolveOperation: ({ scheduleType }) =>
      syntheticDowntimeCreateOperations[downtimeScheduleType.parse(scheduleType)],
    mapVariables: downtimeCreateVariables,
    preReadOperation: ACCOUNT_AND_ENTITIES_GET,
    mapPreReadVariables: ({ accountId, downtime }) => ({
      accountId,
      guids: (downtime as { monitorGuids?: unknown } | undefined)?.monitorGuids ?? [],
    }),
    validatePreRead: (data, arguments_) => {
      requireAccount(data, arguments_);
      const { downtime } = arguments_;
      requireEntities(data, (downtime as { monitorGuids?: unknown } | undefined)?.monitorGuids);
    },
  }),
  write({
    name: 'synthetic_downtime_update',
    title: 'Update synthetic monitor downtime',
    description: 'Update a monitor downtime schedule.',
    toolset: 'synthetics',
    inputSchema: downtimeUpdateToolInput,
    operation: MUTATIONS.syntheticDowntimeUpdate,
    mapVariables: downtimeUpdateVariables,
    preReadOperation: TARGET_AND_ENTITIES_GET,
    mapPreReadVariables: ({ guid, monitorGuids }) => ({
      targetGuid: guid,
      guids: monitorGuids ?? [],
    }),
    validatePreRead: (data, { guid, monitorGuids }) => {
      requireObjectId(data, ['actor', 'target'], guid, 'Synthetic downtime', 'guid');
      requireEntities(data, monitorGuids, ['actor', 'entities']);
    },
    destructive: true,
  }),
  write({
    name: 'synthetic_downtime_delete',
    title: 'Delete synthetic monitor downtime',
    description: 'Delete a monitor downtime schedule.',
    toolset: 'synthetics',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), guid: guidSchema }),
    operation: MUTATIONS.syntheticDowntimeDelete,
    preReadOperation: ENTITY_GET,
    mapPreReadVariables: ({ guid }) => ({ guid }),
    validatePreRead: requireEntity,
    destructive: true,
  }),
];

const workloadInput = z
  .object({
    name: z.string().min(1).max(255),
    entityGuids: z.array(guidSchema).max(25).optional(),
    entitySearchQueries: z
      .array(z.object({ id: idSchema.optional(), query: z.string().min(1).max(4096) }).strict())
      .max(100)
      .optional(),
    scopeAccounts: z.object({ accountIds: z.array(accountIdSchema).min(1).max(100) }).strict(),
  })
  .strict();

const workloadSpecs: InternalToolSpec[] = [
  read({
    name: 'workloads_list',
    title: 'List workloads',
    description: 'List workloads for an account with cursor pagination.',
    toolset: 'workloads',
    inputSchema: accountPageInput,
    operation: WORKLOADS_LIST,
    mapVariables: ({ accountId, cursor }) => ({
      query: `accountId = ${String(accountIdSchema.parse(accountId))} AND type = 'WORKLOAD'`,
      cursor,
    }),
  }),
  read({
    name: 'workload_get',
    title: 'Get a workload',
    description: 'Get workload identity, membership, health, and permalink metadata by GUID.',
    toolset: 'workloads',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: WORKLOAD_GET,
    mapResult: requireEntityResult,
  }),
  read({
    name: 'workload_status_get',
    title: 'Get workload status',
    description: 'Get calculated workload status and rollup summary.',
    toolset: 'workloads',
    inputSchema: z.object({ guid: guidSchema }).strict(),
    operation: WORKLOAD_STATUS_GET,
    mapResult: requireEntityResult,
  }),
  write({
    name: 'workload_create',
    title: 'Create a workload',
    description: 'Create a workload from entity GUIDs and/or entity search queries.',
    toolset: 'workloads',
    inputSchema: writeInput({ accountId: accountIdSchema.optional(), workload: workloadInput }),
    operation: MUTATIONS.workloadCreate,
    preReadOperation: ACCOUNT_AND_ENTITIES_GET,
    mapPreReadVariables: ({ accountId, workload }) => ({
      accountId,
      guids: (workload as { entityGuids?: unknown } | undefined)?.entityGuids ?? [],
    }),
    validatePreRead: (data, arguments_) => {
      requireAccount(data, arguments_);
      const { workload } = arguments_;
      requireEntities(data, (workload as { entityGuids?: unknown } | undefined)?.entityGuids);
    },
  }),
  write({
    name: 'workload_update',
    title: 'Replace a workload',
    description:
      'Replace workload membership queries, entities, scope accounts, and status configuration.',
    toolset: 'workloads',
    inputSchema: writeInput({ guid: guidSchema, workload: workloadInput }),
    operation: MUTATIONS.workloadUpdate,
    preReadOperation: TARGET_AND_ENTITIES_GET,
    mapPreReadVariables: ({ guid, workload }) => ({
      targetGuid: guid,
      guids: (workload as { entityGuids?: unknown } | undefined)?.entityGuids ?? [],
    }),
    validatePreRead: (data, { guid, workload }) => {
      requireObjectId(data, ['actor', 'target'], guid, 'Workload', 'guid');
      requireEntities(data, (workload as { entityGuids?: unknown } | undefined)?.entityGuids, [
        'actor',
        'entities',
      ]);
    },
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'workload_duplicate',
    title: 'Duplicate a workload',
    description: 'Duplicate a workload into an authorized account.',
    toolset: 'workloads',
    inputSchema: writeInput({
      sourceGuid: guidSchema,
      accountId: accountIdSchema.optional(),
      name: z.string().min(1).max(255),
    }),
    operation: MUTATIONS.workloadDuplicate,
    mapVariables: ({ sourceGuid, accountId, name }) => ({
      sourceGuid,
      accountId,
      workload: { name },
    }),
    preReadOperation: ENTITY_AND_ACCOUNT_GET,
    mapPreReadVariables: ({ sourceGuid, accountId }) => ({ guid: sourceGuid, accountId }),
    validatePreRead: (data, { sourceGuid, accountId }) => {
      requireObjectId(data, ['actor', 'entity'], sourceGuid, 'Source workload', 'guid');
      requireObjectId(data, ['actor', 'account'], accountId, 'Destination account');
    },
  }),
  write({
    name: 'workload_delete',
    title: 'Delete a workload',
    description: 'Delete a workload by GUID.',
    toolset: 'workloads',
    inputSchema: writeInput({ guid: guidSchema }),
    operation: MUTATIONS.workloadDelete,
    preReadOperation: WORKLOAD_GET,
    validatePreRead: requireEntity,
    destructive: true,
    idempotent: true,
  }),
];

const serviceLevelEventSelect = z
  .object({
    function: z.enum(['COUNT', 'SUM', 'GET_FIELD', 'GET_CDF_COUNT']),
    attribute: z.string().min(1).max(4096).optional(),
    threshold: z.number().optional(),
  })
  .strict()
  .superRefine(({ function: function_, attribute, threshold }, context) => {
    if (function_ !== 'COUNT' && attribute === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['attribute'],
        message: `attribute is required for ${function_}`,
      });
    }
    if (function_ === 'GET_CDF_COUNT' && threshold === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'threshold is required for GET_CDF_COUNT',
      });
    }
  });
const serviceLevelEventQuery = z
  .object({
    from: z.string().min(1).max(4096),
    where: z.string().min(1).max(16_384).optional(),
    select: serviceLevelEventSelect.optional(),
  })
  .strict()
  .superRefine(({ from, where }, context) => {
    const parsed = readOnlyConfigurationNrqlSchema.safeParse(
      `SELECT count(*) FROM ${from}${where === undefined ? '' : ` WHERE ${where}`}`,
    );
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: ['from'], message: issue.message });
      }
    }
  });
const serviceLevelEventsCreate = z
  .object({
    accountId: accountIdSchema,
    validEvents: serviceLevelEventQuery,
    goodEvents: serviceLevelEventQuery.optional(),
    badEvents: serviceLevelEventQuery.optional(),
  })
  .strict()
  .refine(
    ({ goodEvents, badEvents }) => (goodEvents === undefined) !== (badEvents === undefined),
    'exactly one of goodEvents or badEvents is required',
  );
const serviceLevelEventsUpdate = z
  .object({
    validEvents: serviceLevelEventQuery.optional(),
    goodEvents: serviceLevelEventQuery.optional(),
    badEvents: serviceLevelEventQuery.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'events update must not be empty');
const serviceLevelObjective = z
  .object({
    name: z.string().max(255).optional(),
    description: z.string().max(4000).optional(),
    target: z.number().min(0).max(100),
    timeWindow: z
      .object({
        rolling: z
          .object({
            count: z.union([z.literal(1), z.literal(7), z.literal(28)]),
            unit: z.literal('DAY'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const serviceLevelIndicatorCreateInput = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    events: serviceLevelEventsCreate,
    objectives: z.array(serviceLevelObjective).min(1).max(100),
  })
  .strict();
const serviceLevelIndicatorUpdateInput = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(4000).optional(),
    events: serviceLevelEventsUpdate.optional(),
    objectives: z.array(serviceLevelObjective).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'indicator update must not be empty');
const maintenanceWindowInput = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    scope: z.object({ id: z.string().min(1), type: z.literal('ACCOUNT') }).strict(),
    startTime: z.iso.datetime({ local: true }),
    duration: z.string().regex(/^P(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/u),
    rrule: z.string().max(4096).optional(),
    timezone: z.string().min(1).max(255),
    affectedEntityType: z.literal('SERVICE_LEVEL'),
    affectedEntities: z.array(guidSchema).max(25).optional(),
  })
  .strict();
const maintenanceWindowUpdateInput = maintenanceWindowInput
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'maintenance window update must not be empty');

function filterServiceLevelIndicator(data: unknown, id: unknown): unknown {
  if (!data || typeof data !== 'object') return notFound('Service level', id);
  const root = data as Record<string, unknown>;
  const actor = root.actor;
  if (!actor || typeof actor !== 'object') return notFound('Service level', id);
  const entity = (actor as Record<string, unknown>).entity;
  if (!entity || typeof entity !== 'object') return notFound('Service level', id);
  const serviceLevel = (entity as Record<string, unknown>).serviceLevel;
  if (!serviceLevel || typeof serviceLevel !== 'object') return notFound('Service level', id);
  const indicators = (serviceLevel as Record<string, unknown>).indicators;
  if (!Array.isArray(indicators)) return notFound('Service level', id);
  const matchingIndicators = indicators.filter(
    (indicator) =>
      indicator &&
      typeof indicator === 'object' &&
      String((indicator as Record<string, unknown>).id) === String(id),
  );
  if (matchingIndicators.length === 0) return notFound('Service level', id);
  return {
    ...root,
    actor: {
      ...(actor as Record<string, unknown>),
      entity: {
        ...(entity as Record<string, unknown>),
        serviceLevel: {
          ...(serviceLevel as Record<string, unknown>),
          indicators: matchingIndicators,
        },
      },
    },
  };
}

function requireServiceLevel(data: unknown, arguments_: Record<string, unknown>): void {
  filterServiceLevelIndicator(data, arguments_.id);
}

const serviceLevelSpecs: InternalToolSpec[] = [
  read({
    name: 'service_levels_list',
    title: 'List service levels',
    description: 'List service-level indicators attached to an entity.',
    toolset: 'service-levels',
    inputSchema: z.object({ entityGuid: guidSchema }).strict(),
    operation: SERVICE_LEVELS_LIST,
    mapResult: (data, arguments_) => requireEntityResult(data, arguments_, 'entityGuid'),
  }),
  read({
    name: 'service_level_get',
    title: 'Get a service level',
    description: 'Get a service-level indicator by ID from an entity.',
    toolset: 'service-levels',
    inputSchema: z.object({ entityGuid: guidSchema, id: idSchema }).strict(),
    operation: SERVICE_LEVEL_GET,
    mapResult: (data, { id }) => filterServiceLevelIndicator(data, id),
  }),
  read({
    name: 'service_level_results',
    title: 'Query service-level results',
    description: 'Run a bounded read-only result query for a service-level indicator.',
    toolset: 'service-levels',
    inputSchema: z
      .object({ accountId: accountIdSchema.optional(), query: z.string().min(1).max(16_384) })
      .strict(),
    operation: SERVICE_LEVEL_RESULTS,
    mapVariables: nrqlVariables,
  }),
  read({
    name: 'maintenance_windows_list',
    title: 'List service-level maintenance windows',
    description: 'Get maintenance windows by IDs.',
    toolset: 'service-levels',
    inputSchema: z.object({ ids: z.array(idSchema).min(1).max(100) }).strict(),
    operation: MAINTENANCE_WINDOWS_LIST,
  }),
  write({
    name: 'service_level_create',
    title: 'Create a service level',
    description: 'Create an SLI and its objectives for an entity.',
    toolset: 'service-levels',
    inputSchema: writeInput({
      entityGuid: guidSchema,
      indicator: serviceLevelIndicatorCreateInput,
    }),
    operation: MUTATIONS.serviceLevelCreate,
    preReadOperation: SERVICE_LEVELS_LIST,
    mapPreReadVariables: ({ entityGuid }) => ({ entityGuid }),
    validatePreRead: (data, arguments_) => requireEntity(data, arguments_, 'entityGuid'),
  }),
  write({
    name: 'service_level_update',
    title: 'Update a service level',
    description:
      'Update an SLI definition and objectives. No unsupported delete mutation is exposed.',
    toolset: 'service-levels',
    inputSchema: writeInput({
      entityGuid: guidSchema,
      id: idSchema,
      indicator: serviceLevelIndicatorUpdateInput,
    }),
    operation: MUTATIONS.serviceLevelUpdate,
    preReadOperation: SERVICE_LEVEL_GET,
    validatePreRead: requireServiceLevel,
    destructive: true,
  }),
  write({
    name: 'maintenance_window_create',
    title: 'Create a maintenance window',
    description: 'Create a service-level maintenance window.',
    toolset: 'service-levels',
    inputSchema: writeInput({ maintenanceWindow: maintenanceWindowInput }),
    operation: MUTATIONS.maintenanceWindowCreate,
    preReadOperation: ACCOUNT_AND_ENTITIES_GET,
    mapPreReadVariables: ({ maintenanceWindow }) => {
      const value = maintenanceWindow as {
        scope?: { id?: unknown };
        affectedEntities?: unknown;
      };
      return {
        accountId: Number(value.scope?.id),
        guids: value.affectedEntities ?? [],
      };
    },
    validatePreRead: (data, { maintenanceWindow }) => {
      const value = maintenanceWindow as {
        scope?: { id?: unknown };
        affectedEntities?: unknown;
      };
      requireObjectId(data, ['actor', 'account'], value.scope?.id, 'Account');
      requireEntities(data, value.affectedEntities);
    },
  }),
  write({
    name: 'maintenance_window_update',
    title: 'Update a maintenance window',
    description: 'Replace selected maintenance-window fields.',
    toolset: 'service-levels',
    inputSchema: writeInput({ id: idSchema, maintenanceWindow: maintenanceWindowUpdateInput }),
    operation: MUTATIONS.maintenanceWindowUpdate,
    preReadOperation: MAINTENANCE_WINDOW_AND_ENTITIES,
    mapPreReadVariables: ({ id, maintenanceWindow }) => ({
      ids: [id],
      guids:
        (maintenanceWindow as { affectedEntities?: unknown } | undefined)?.affectedEntities ?? [],
    }),
    validatePreRead: (data, { id, maintenanceWindow }) => {
      requireListId(
        ['actor', 'maintenanceWindow', 'listByIds', 'maintenanceWindows'],
        'Maintenance window',
      )(data, { id });
      requireEntities(
        data,
        (maintenanceWindow as { affectedEntities?: unknown } | undefined)?.affectedEntities,
      );
    },
    destructive: true,
  }),
  write({
    name: 'maintenance_window_delete',
    title: 'Delete a maintenance window',
    description: 'Delete a service-level maintenance window.',
    toolset: 'service-levels',
    inputSchema: writeInput({ id: idSchema }),
    operation: MUTATIONS.maintenanceWindowDelete,
    preReadOperation: MAINTENANCE_WINDOWS_LIST,
    mapPreReadVariables: ({ id }) => ({ ids: [id] }),
    validatePreRead: requireListId(
      ['actor', 'maintenanceWindow', 'listByIds', 'maintenanceWindows'],
      'Maintenance window',
    ),
    destructive: true,
  }),
];

const logOperation =
  (action: 'create' | 'update' | 'delete') =>
  (arguments_: Record<string, unknown>): NerdGraphOperation => {
    const type =
      action === 'delete'
        ? arguments_.type
        : (arguments_.configuration as { type?: unknown } | undefined)?.type;
    const prefix =
      type === 'partition'
        ? 'logPartition'
        : type === 'parsing_rule'
          ? 'logParsingRule'
          : type === 'obfuscation_expression'
            ? 'logObfuscationExpression'
            : 'logObfuscationRule';
    const key =
      `${prefix}${action[0]?.toUpperCase() ?? ''}${action.slice(1)}` as keyof typeof MUTATIONS;
    return MUTATIONS[key];
  };
const logVariables = (arguments_: Record<string, unknown>) => {
  const { configuration, type, ...rest } = arguments_;
  if (configuration && typeof configuration === 'object') {
    const { type: configurationType, ...value } = configuration as Record<string, unknown>;
    const { id, ...withoutId } = rest;
    const field = configurationType === 'obfuscation_expression' ? 'expression' : 'rule';
    const embedsId =
      id !== undefined &&
      (configurationType === 'partition' ||
        configurationType === 'obfuscation_expression' ||
        configurationType === 'obfuscation_rule');
    return {
      ...withoutId,
      ...(id === undefined || embedsId ? {} : { id }),
      [field]: embedsId ? { ...value, id } : value,
    };
  }
  return { ...rest, type };
};

function requireLogConfiguration(data: unknown, arguments_: Record<string, unknown>): void {
  const type =
    arguments_.type ?? (arguments_.configuration as { type?: unknown } | undefined)?.type;
  const listName =
    type === 'partition'
      ? 'dataPartitionRules'
      : type === 'parsing_rule'
        ? 'parsingRules'
        : type === 'obfuscation_expression'
          ? 'obfuscationExpressions'
          : 'obfuscationRules';
  requireListId(['actor', 'account', 'logConfigurations', listName], 'Log configuration')(
    data,
    arguments_,
  );
}

const logSpecs: InternalToolSpec[] = [
  read({
    name: 'log_configurations_list',
    title: 'List log configurations',
    description:
      'List log partitions, parsing rules, obfuscation expressions, and obfuscation rules.',
    toolset: 'logs',
    inputSchema: accountInput,
    operation: LOG_CONFIGURATIONS_LIST,
  }),
  write({
    name: 'log_configuration_create',
    title: 'Create a log configuration',
    description:
      'Create a typed log partition, parsing rule, obfuscation expression, or obfuscation rule.',
    toolset: 'logs',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      configuration: logConfigurationInputSchema,
    }),
    operation: MUTATIONS.logPartitionCreate,
    resolveOperation: logOperation('create'),
    mapVariables: logVariables,
    preReadOperation: LOG_CONFIGURATIONS_LIST,
    validatePreRead: requireAccount,
  }),
  write({
    name: 'log_configuration_update',
    title: 'Update a log configuration',
    description: 'Update a typed log configuration.',
    toolset: 'logs',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      configuration: logConfigurationInputSchema,
    }),
    operation: MUTATIONS.logPartitionUpdate,
    resolveOperation: logOperation('update'),
    mapVariables: logVariables,
    preReadOperation: LOG_CONFIGURATIONS_LIST,
    validatePreRead: requireLogConfiguration,
    destructive: true,
  }),
  write({
    name: 'log_configuration_delete',
    title: 'Delete a log configuration',
    description: 'Delete a typed log configuration.',
    toolset: 'logs',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      type: z.enum(['partition', 'parsing_rule', 'obfuscation_expression', 'obfuscation_rule']),
    }),
    operation: MUTATIONS.logPartitionDelete,
    resolveOperation: logOperation('delete'),
    mapVariables: logVariables,
    preReadOperation: LOG_CONFIGURATIONS_LIST,
    validatePreRead: requireLogConfiguration,
    destructive: true,
  }),
];

function filterPipelineRules(data: unknown, accountId: unknown): unknown {
  const root = data as JsonObject;
  const actor = objectAt(root, ['actor']);
  const entityManagement = objectAt(root, ['actor', 'entityManagement']);
  const entitySearch = objectAt(root, ['actor', 'entityManagement', 'entitySearch']);
  const entities = arrayAt(root, ['actor', 'entityManagement', 'entitySearch', 'entities']);
  if (actor === undefined || entityManagement === undefined || entitySearch === undefined) {
    throw new CapabilityError('upstream_schema', 'Pipeline rule response omitted its result path');
  }
  return {
    ...root,
    actor: {
      ...actor,
      entityManagement: {
        ...entityManagement,
        entitySearch: {
          ...entitySearch,
          entities: (entities ?? []).filter((entity) => {
            if (entity === null || typeof entity !== 'object') return false;
            const scope = (entity as JsonObject).scope;
            return (
              scope !== null &&
              typeof scope === 'object' &&
              (scope as JsonObject).type === 'ACCOUNT' &&
              String((scope as JsonObject).id) === String(accountId)
            );
          }),
        },
      },
    },
  };
}

const metricSpecs: InternalToolSpec[] = [
  read({
    name: 'metric_normalization_rules_list',
    title: 'List metric normalization rules',
    description: 'List metric normalization rules and enabled state.',
    toolset: 'metrics',
    inputSchema: accountInput,
    operation: METRIC_NORMALIZATION_RULES_LIST,
  }),
  read({
    name: 'pipeline_rules_list',
    title: 'List Pipeline Control rules',
    description:
      'List current Pipeline Control cloud rules. Results are filtered to configured account scopes.',
    toolset: 'metrics',
    inputSchema: accountInput,
    operation: PIPELINE_RULES_LIST,
    mapVariables: () => ({ query: "type = 'PIPELINE_CLOUD_RULE'" }),
    mapResult: (data, { accountId }) => filterPipelineRules(data, accountId),
  }),
  write({
    name: 'metric_normalization_rule_create',
    title: 'Create a metric normalization rule',
    description: 'Create a preview metric normalization rule.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      rule: metricNormalizationInputSchema,
    }),
    operation: MUTATIONS.metricNormalizationCreate,
    preReadOperation: METRIC_NORMALIZATION_RULES_LIST,
    validatePreRead: requireAccount,
    preview: true,
    destructive: true,
  }),
  write({
    name: 'metric_normalization_rule_update',
    title: 'Update a metric normalization rule',
    description: 'Edit a preview metric normalization rule.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      ruleId: z.number().int().positive(),
      rule: metricNormalizationInputSchema,
    }),
    operation: MUTATIONS.metricNormalizationUpdate,
    mapVariables: ({ accountId, ruleId, rule }) => ({
      accountId,
      rule: { ...(rule as Record<string, unknown>), id: ruleId },
    }),
    preReadOperation: METRIC_NORMALIZATION_RULES_LIST,
    validatePreRead: requireListId(
      ['actor', 'account', 'metricNormalization', 'metricNormalizationRules'],
      'Metric normalization rule',
      'ruleId',
    ),
    preview: true,
    destructive: true,
  }),
  write({
    name: 'metric_normalization_rule_enable',
    title: 'Enable a metric normalization rule',
    description: 'Enable a preview metric normalization rule.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      ruleId: z.number().int().positive(),
    }),
    operation: MUTATIONS.metricNormalizationEnable,
    preReadOperation: METRIC_NORMALIZATION_RULES_LIST,
    validatePreRead: requireListId(
      ['actor', 'account', 'metricNormalization', 'metricNormalizationRules'],
      'Metric normalization rule',
      'ruleId',
    ),
    preview: true,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'metric_normalization_rule_disable',
    title: 'Disable a metric normalization rule',
    description: 'Disable a preview metric normalization rule.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      ruleId: z.number().int().positive(),
    }),
    operation: MUTATIONS.metricNormalizationDisable,
    preReadOperation: METRIC_NORMALIZATION_RULES_LIST,
    validatePreRead: requireListId(
      ['actor', 'account', 'metricNormalization', 'metricNormalizationRules'],
      'Metric normalization rule',
      'ruleId',
    ),
    preview: true,
    destructive: true,
    idempotent: true,
  }),
  write({
    name: 'pipeline_rule_create',
    title: 'Create a Pipeline Control rule',
    description: 'Create a current Pipeline Control cloud rule that suppresses future data.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      rule: z
        .object({
          name: z.string().min(1).max(255),
          description: z.string().min(1).max(4000),
          nrql: pipelineDeleteNrqlSchema,
          enabled: z.boolean().optional(),
        })
        .strict(),
    }),
    operation: MUTATIONS.pipelineRuleCreate,
    mapVariables: ({ accountId, rule }) => ({
      pipelineCloudRuleEntity: {
        ...(rule as Record<string, unknown>),
        scope: { id: String(accountId), type: 'ACCOUNT' },
      },
    }),
    preReadOperation: ACCOUNT_ACCESS,
    validatePreRead: requireAccount,
    preview: true,
    destructive: true,
  }),
  write({
    name: 'pipeline_rule_update',
    title: 'Update a Pipeline Control rule',
    description: 'Update a current Pipeline Control cloud rule that suppresses future data.',
    toolset: 'metrics',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      id: idSchema,
      version: z.number().int().nonnegative().optional(),
      rule: z
        .object({
          name: z.string().min(1).max(255),
          description: z.string().min(1).max(4000),
          nrql: pipelineDeleteNrqlSchema,
          enabled: z.boolean(),
        })
        .strict(),
    }),
    operation: MUTATIONS.pipelineRuleUpdate,
    mapVariables: ({ id, version, rule }) => ({
      id,
      version,
      pipelineCloudRuleEntity: rule,
    }),
    preReadOperation: PIPELINE_RULES_LIST,
    mapPreReadVariables: () => ({ query: "type = 'PIPELINE_CLOUD_RULE'" }),
    validatePreRead: (data, arguments_) => {
      const entities = arrayAt(data, ['actor', 'entityManagement', 'entitySearch', 'entities']);
      const matching = entities?.find(
        (entity) =>
          entity !== null &&
          typeof entity === 'object' &&
          String((entity as JsonObject).id) === String(arguments_.id),
      ) as JsonObject | undefined;
      if (matching === undefined) notFound('Pipeline rule', arguments_.id);
      const scope = matching.scope as JsonObject | undefined;
      if (scope?.type !== 'ACCOUNT' || String(scope.id) !== String(arguments_.accountId)) {
        notFound('Pipeline rule in the requested account', arguments_.id);
      }
    },
    preview: true,
    destructive: true,
  }),
];

const userType = z.enum(['FULL_USER_TIER', 'CORE_USER_TIER', 'BASIC_USER_TIER']);
const adminResourcesInput = z
  .object({
    organizationId: idSchema,
    authenticationDomainCursor: cursorSchema.optional(),
    groupCursor: cursorSchema.optional(),
    grantCursor: cursorSchema.optional(),
    roleCursor: cursorSchema.optional(),
    dataAccessPolicyCursor: cursorSchema.optional(),
    permissionCursor: cursorSchema.optional(),
  })
  .strict();
const dataPolicyDocument = z
  .object({
    rules: z
      .array(
        z
          .object({
            operations: z.array(z.string()).min(1),
            eventTypes: z
              .object({ allow: z.array(z.string()), except: z.array(z.string()) })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function requireAdminResource(
  data: unknown,
  collection: 'authenticationDomains' | 'groups' | 'roles' | 'grants' | 'dataAccessPolicies',
  expected: unknown,
  resource: string,
): void {
  requireEveryListId(data, ['customerAdministration', collection, 'items'], [expected], resource);
}

function adminTargetVariables(
  arguments_: Record<string, unknown>,
  target: 'authenticationDomain' | 'group' | 'role' | 'dataAccessPolicy',
): Record<string, unknown> {
  return {
    organizationId: arguments_.organizationId,
    authenticationDomainId:
      target === 'authenticationDomain' ? arguments_.authenticationDomainId : '__unused__',
    groupId: target === 'group' ? arguments_.id : '__unused__',
    roleId: target === 'role' ? arguments_.id : -1,
  };
}

function apiKeyMatches(key: unknown, id: unknown, type: unknown, accountId: unknown): boolean {
  return (
    key !== null &&
    typeof key === 'object' &&
    String((key as JsonObject).id) === String(id) &&
    String((key as JsonObject).type) === String(type) &&
    String((key as JsonObject).accountId) === String(accountId)
  );
}

function requireApiKeys(data: unknown, arguments_: Record<string, unknown>): void {
  const keys = arrayAt(data, ['actor', 'apiAccess', 'keySearch', 'keys']);
  const expected = Array.isArray(arguments_.keyIds) ? arguments_.keyIds : [arguments_.keyId];
  const missing = expected.filter(
    (id) => !keys?.some((key) => apiKeyMatches(key, id, arguments_.keyType, arguments_.accountId)),
  );
  if (keys === undefined || missing.length > 0) {
    throw new CapabilityError(
      'not_found',
      'API key metadata was not found in the requested account',
      {
        missingIds: missing.map(String),
      },
    );
  }
}

function filterApiKeys(data: unknown, accountId: unknown): unknown {
  const root = data as JsonObject;
  const actor = objectAt(root, ['actor']);
  const apiAccess = objectAt(root, ['actor', 'apiAccess']);
  const keySearch = objectAt(root, ['actor', 'apiAccess', 'keySearch']);
  const keys = arrayAt(root, ['actor', 'apiAccess', 'keySearch', 'keys']);
  if (actor === undefined || apiAccess === undefined || keySearch === undefined) {
    throw new CapabilityError('upstream_schema', 'API key response omitted its result path');
  }
  return {
    ...root,
    actor: {
      ...actor,
      apiAccess: {
        ...apiAccess,
        keySearch: {
          ...keySearch,
          keys: (keys ?? []).filter(
            (key) =>
              key !== null &&
              typeof key === 'object' &&
              String((key as JsonObject).accountId) === String(accountId),
          ),
        },
      },
    },
  };
}

const adminSpecs: InternalToolSpec[] = [
  read({
    name: 'organization_get',
    title: 'Get organization',
    description: 'Get non-secret organization metadata.',
    toolset: 'admin',
    inputSchema: emptyInput,
    operation: ORGANIZATION_GET,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'admin_resources_list',
    title: 'List administration resources',
    description:
      'List authentication domains, groups, grants, roles, policies, and permissions for an organization.',
    toolset: 'admin',
    inputSchema: adminResourcesInput,
    operation: ADMIN_RESOURCES_LIST,
    omitPagination: true,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'audit_events_query',
    title: 'Query audit events',
    description:
      'Read bounded NrAuditEvent history with no tool input values used as labels or logs.',
    toolset: 'admin',
    inputSchema: incidentListInput,
    operation: NRQL_QUERY,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
    fixedNrql: ({ since, limit }) =>
      `SELECT * FROM NrAuditEvent SINCE ${escapeNrqlLiteral(since)} LIMIT ${String(limit)}`,
  }),
  read({
    name: 'users_list',
    title: 'List users',
    description: 'List users in one authentication domain.',
    toolset: 'admin',
    inputSchema: z
      .object({ authenticationDomainId: idSchema, cursor: cursorSchema.optional() })
      .strict(),
    operation: ADMIN_USERS_LIST,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'groups_list',
    title: 'List groups',
    description: 'List group resources within the organization administration view.',
    toolset: 'admin',
    inputSchema: z.object({ organizationId: idSchema, cursor: cursorSchema.optional() }).strict(),
    operation: ADMIN_GROUPS_LIST,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'custom_roles_list',
    title: 'List roles and permissions',
    description: 'List role and permission resources within the organization administration view.',
    toolset: 'admin',
    inputSchema: z
      .object({
        organizationId: idSchema,
        roleCursor: cursorSchema.optional(),
        permissionCursor: cursorSchema.optional(),
      })
      .strict(),
    operation: ADMIN_ROLES_LIST,
    omitPagination: true,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'access_grants_list',
    title: 'List access grants',
    description: 'List access grants and attached data access policy metadata.',
    toolset: 'admin',
    inputSchema: z.object({ organizationId: idSchema, cursor: cursorSchema.optional() }).strict(),
    operation: ADMIN_GRANTS_LIST,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'data_access_policies_list',
    title: 'List data access policies',
    description: 'List data access policies without exposing log data.',
    toolset: 'admin',
    inputSchema: z.object({ organizationId: idSchema, cursor: cursorSchema.optional() }).strict(),
    operation: ADMIN_DATA_ACCESS_POLICIES_LIST,
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  read({
    name: 'api_keys_list',
    title: 'List API key metadata',
    description: 'List API key IDs and metadata only. Key values are never requested.',
    toolset: 'admin',
    inputSchema: accountInput,
    operation: API_KEYS_LIST,
    mapResult: (data, { accountId }) => filterApiKeys(data, accountId),
    requiredScope: 'newrelic:admin',
    gate: 'admin',
  }),
  write({
    name: 'account_create',
    title: 'Create an account',
    description: 'Create a managed New Relic account.',
    toolset: 'admin',
    inputSchema: writeInput({
      managedAccount: z
        .object({
          name: z.string().min(1).max(255),
          regionCode: z.enum(['us01', 'eu01']).optional(),
        })
        .strict(),
    }),
    operation: MUTATIONS.accountCreate,
    admin: true,
  }),
  write({
    name: 'account_update',
    title: 'Rename an account',
    description: 'Rename a managed New Relic account.',
    toolset: 'admin',
    inputSchema: writeInput({
      managedAccount: z.object({ id: accountIdSchema, name: z.string().min(1).max(255) }).strict(),
    }),
    operation: MUTATIONS.accountUpdate,
    preReadOperation: ACCOUNT_ACCESS,
    mapPreReadVariables: ({ managedAccount }) => ({
      accountId: (managedAccount as { id?: unknown }).id,
    }),
    validatePreRead: (data, { managedAccount }) => {
      requireObjectId(
        data,
        ['actor', 'account'],
        (managedAccount as { id?: unknown }).id,
        'Account',
      );
    },
    admin: true,
  }),
  write({
    name: 'account_cancel',
    title: 'Cancel an account',
    description: 'Cancel a managed New Relic account.',
    toolset: 'admin',
    inputSchema: writeInput({ id: accountIdSchema }),
    operation: MUTATIONS.accountCancel,
    preReadOperation: ACCOUNT_ACCESS,
    mapPreReadVariables: ({ id }) => ({ accountId: id }),
    validatePreRead: (data, { id }) => {
      requireObjectId(data, ['actor', 'account'], id, 'Account');
    },
    admin: true,
    destructive: true,
  }),
  write({
    name: 'user_create',
    title: 'Create a user',
    description: 'Create a manually provisioned user.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      authenticationDomainId: idSchema,
      email: z.email(),
      name: z.string().min(1).max(255),
      userType,
    }),
    operation: MUTATIONS.userCreate,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'authenticationDomain'),
    validatePreRead: (data, { authenticationDomainId }) => {
      requireAdminResource(
        data,
        'authenticationDomains',
        authenticationDomainId,
        'Authentication domain',
      );
    },
    admin: true,
  }),
  write({
    name: 'user_update',
    title: 'Update a user',
    description: "Update a manually provisioned user's name, email, or tier.",
    toolset: 'admin',
    inputSchema: writeInput({
      authenticationDomainId: idSchema,
      id: idSchema,
      email: z.email().optional(),
      name: z.string().min(1).max(255).optional(),
      timeZone: z.string().min(1).max(255).optional(),
      userType: userType.optional(),
    }),
    operation: MUTATIONS.userUpdate,
    preReadOperation: ADMIN_USER_GET,
    mapPreReadVariables: ({ authenticationDomainId, id }) => ({ authenticationDomainId, id }),
    validatePreRead: requireListId(['customerAdministration', 'users', 'items'], 'User'),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'user_delete',
    title: 'Delete a user',
    description: 'Delete a manually provisioned user.',
    toolset: 'admin',
    inputSchema: writeInput({ authenticationDomainId: idSchema, id: idSchema }),
    operation: MUTATIONS.userDelete,
    preReadOperation: ADMIN_USER_GET,
    mapPreReadVariables: ({ authenticationDomainId, id }) => ({ authenticationDomainId, id }),
    validatePreRead: requireListId(['customerAdministration', 'users', 'items'], 'User'),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'group_create',
    title: 'Create a group',
    description: 'Create a group in a manually provisioned authentication domain.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      authenticationDomainId: idSchema,
      displayName: z.string().min(1).max(255),
    }),
    operation: MUTATIONS.groupCreate,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'authenticationDomain'),
    validatePreRead: (data, { authenticationDomainId }) => {
      requireAdminResource(
        data,
        'authenticationDomains',
        authenticationDomainId,
        'Authentication domain',
      );
    },
    admin: true,
  }),
  write({
    name: 'group_update',
    title: 'Update a group',
    description: 'Rename a manually provisioned group.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      id: idSchema,
      displayName: z.string().min(1).max(255),
    }),
    operation: MUTATIONS.groupUpdate,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'group'),
    validatePreRead: (data, { id }) => requireAdminResource(data, 'groups', id, 'Group'),
    admin: true,
  }),
  write({
    name: 'group_delete',
    title: 'Delete a group',
    description: 'Delete a manually provisioned group.',
    toolset: 'admin',
    inputSchema: writeInput({ organizationId: idSchema, id: idSchema }),
    operation: MUTATIONS.groupDelete,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'group'),
    validatePreRead: (data, { id }) => requireAdminResource(data, 'groups', id, 'Group'),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'group_membership_add',
    title: 'Add users to groups',
    description: 'Add manually provisioned users to groups.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      authenticationDomainId: idSchema,
      groupIds: z.array(idSchema).length(1),
      userIds: z.array(idSchema).length(1),
    }),
    operation: MUTATIONS.groupMembershipAdd,
    preReadOperation: ADMIN_MEMBERSHIP_PREREAD,
    mapPreReadVariables: ({ organizationId, authenticationDomainId, groupIds, userIds }) => ({
      organizationId,
      authenticationDomainId,
      groupId: (groupIds as unknown[])[0],
      userId: (userIds as unknown[])[0],
    }),
    validatePreRead: (data, { groupIds, userIds, authenticationDomainId }) => {
      requireEveryListId(data, ['customerAdministration', 'groups', 'items'], groupIds, 'Group');
      requireEveryListId(data, ['customerAdministration', 'users', 'items'], userIds, 'User');
      const groups = arrayAt(data, ['customerAdministration', 'groups', 'items']) ?? [];
      if (
        groups.some(
          (group) =>
            group !== null &&
            typeof group === 'object' &&
            (groupIds as unknown[]).map(String).includes(String((group as JsonObject).id)) &&
            String((group as JsonObject).authenticationDomainId) !== String(authenticationDomainId),
        )
      ) {
        throw new CapabilityError(
          'not_found',
          'A group is outside the requested authentication domain',
        );
      }
    },
    admin: true,
  }),
  write({
    name: 'group_membership_remove',
    title: 'Remove users from groups',
    description: 'Remove users from manually provisioned groups.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      authenticationDomainId: idSchema,
      groupIds: z.array(idSchema).length(1),
      userIds: z.array(idSchema).length(1),
    }),
    operation: MUTATIONS.groupMembershipRemove,
    preReadOperation: ADMIN_MEMBERSHIP_PREREAD,
    mapPreReadVariables: ({ organizationId, authenticationDomainId, groupIds, userIds }) => ({
      organizationId,
      authenticationDomainId,
      groupId: (groupIds as unknown[])[0],
      userId: (userIds as unknown[])[0],
    }),
    validatePreRead: (data, { groupIds, userIds }) => {
      requireEveryListId(data, ['customerAdministration', 'groups', 'items'], groupIds, 'Group');
      requireEveryListId(data, ['customerAdministration', 'users', 'items'], userIds, 'User');
    },
    admin: true,
    destructive: true,
  }),
  write({
    name: 'custom_role_create',
    title: 'Create a custom role',
    description: 'Create a scoped custom role from documented permission IDs.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      name: z.string().min(1).max(255),
      permissionIds: z.array(z.number().int().positive()).min(1).max(500),
      scope: z.enum(['account', 'organization', 'entity']),
    }),
    operation: MUTATIONS.customRoleCreate,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'role'),
    admin: true,
  }),
  write({
    name: 'custom_role_update',
    title: 'Update a custom role',
    description: 'Replace a custom role name and permission IDs.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      id: z.number().int().positive(),
      name: z.string().min(1).max(255),
      permissionIds: z.array(z.number().int().positive()).min(1).max(500),
    }),
    operation: MUTATIONS.customRoleUpdate,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'role'),
    validatePreRead: (data, { id }) => requireAdminResource(data, 'roles', id, 'Custom role'),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'custom_role_delete',
    title: 'Delete a custom role',
    description: 'Delete a custom role.',
    toolset: 'admin',
    inputSchema: writeInput({ organizationId: idSchema, id: z.number().int().positive() }),
    operation: MUTATIONS.customRoleDelete,
    preReadOperation: ADMIN_TARGETS_GET,
    mapPreReadVariables: (arguments_) => adminTargetVariables(arguments_, 'role'),
    validatePreRead: (data, { id }) => requireAdminResource(data, 'roles', id, 'Custom role'),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'access_grant_create',
    title: 'Create an access grant',
    description: 'Grant documented account, organization, entity, or group access.',
    toolset: 'admin',
    inputSchema: writeInput({ organizationId: idSchema, options: authorizationAccessSchema }),
    operation: MUTATIONS.accessGrantCreate,
    preReadOperation: ADMIN_RESOURCES_LIST,
    mapPreReadVariables: ({ organizationId }) => ({ organizationId }),
    admin: true,
  }),
  write({
    name: 'access_grant_delete',
    title: 'Revoke an access grant',
    description: 'Revoke documented account, organization, entity, or group access.',
    toolset: 'admin',
    inputSchema: writeInput({ organizationId: idSchema, options: authorizationAccessSchema }),
    operation: MUTATIONS.accessGrantDelete,
    preReadOperation: ADMIN_RESOURCES_LIST,
    mapPreReadVariables: ({ organizationId }) => ({ organizationId }),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'data_access_policy_create',
    title: 'Create a data access policy',
    description: 'Create a log data access policy.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      name: z.string().min(1).max(255),
      policy: dataPolicyDocument,
    }),
    operation: MUTATIONS.dataAccessPolicyCreate,
    preReadOperation: ADMIN_RESOURCES_LIST,
    mapPreReadVariables: ({ organizationId }) => ({ organizationId }),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'data_access_policy_update',
    title: 'Update a data access policy',
    description: 'Update a log data access policy.',
    toolset: 'admin',
    inputSchema: writeInput({
      organizationId: idSchema,
      id: idSchema,
      name: z.string().min(1).max(255).optional(),
      policy: dataPolicyDocument.optional(),
    }),
    operation: MUTATIONS.dataAccessPolicyUpdate,
    preReadOperation: ADMIN_DATA_ACCESS_POLICIES_LIST,
    mapPreReadVariables: ({ organizationId }) => ({ organizationId }),
    preReadConnections: [
      {
        cursorVariable: 'cursor',
        path: ['customerAdministration', 'dataAccessPolicies'],
      },
    ],
    validatePreRead: (data, { id }) =>
      requireAdminResource(data, 'dataAccessPolicies', id, 'Data access policy'),
    projectPreRead: projectListTarget(['customerAdministration', 'dataAccessPolicies', 'items']),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'data_access_policy_delete',
    title: 'Delete a data access policy',
    description: 'Delete a data access policy and remove it from assigned grants.',
    toolset: 'admin',
    inputSchema: writeInput({ organizationId: idSchema, id: idSchema }),
    operation: MUTATIONS.dataAccessPolicyDelete,
    preReadOperation: ADMIN_DATA_ACCESS_POLICIES_LIST,
    mapPreReadVariables: ({ organizationId }) => ({ organizationId }),
    preReadConnections: [
      {
        cursorVariable: 'cursor',
        path: ['customerAdministration', 'dataAccessPolicies'],
      },
    ],
    validatePreRead: (data, { id }) =>
      requireAdminResource(data, 'dataAccessPolicies', id, 'Data access policy'),
    projectPreRead: projectListTarget(['customerAdministration', 'dataAccessPolicies', 'items']),
    admin: true,
    destructive: true,
  }),
  write({
    name: 'api_key_update',
    title: 'Update API key metadata',
    description: "Update one API key's name or notes without requesting or returning key material.",
    toolset: 'admin',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      keyType: z.enum(['INGEST', 'USER']),
      keyId: idSchema,
      name: z.string().min(1).max(255).optional(),
      notes: z.string().max(4000).optional(),
    }),
    operation: MUTATIONS.apiIngestKeyUpdate,
    resolveOperation: ({ keyType }) =>
      keyType === 'USER' ? MUTATIONS.apiUserKeyUpdate : MUTATIONS.apiIngestKeyUpdate,
    preReadOperation: API_KEYS_LIST,
    mapPreReadVariables: ({ accountId }) => ({ accountId }),
    validatePreRead: requireApiKeys,
    admin: true,
  }),
  write({
    name: 'api_key_delete',
    title: 'Delete API keys',
    description: 'Revoke selected non-original API keys by ID.',
    toolset: 'admin',
    inputSchema: writeInput({
      accountId: accountIdSchema.optional(),
      keyType: z.enum(['INGEST', 'USER']),
      keyIds: z.array(idSchema).min(1).max(100),
    }),
    operation: MUTATIONS.apiIngestKeyDelete,
    resolveOperation: ({ keyType }) =>
      keyType === 'USER' ? MUTATIONS.apiUserKeyDelete : MUTATIONS.apiIngestKeyDelete,
    preReadOperation: API_KEYS_LIST,
    mapPreReadVariables: ({ accountId }) => ({ accountId }),
    validatePreRead: requireApiKeys,
    admin: true,
    destructive: true,
  }),
];

/** Capabilities intentionally omitted despite related NerdGraph fields. */
export const EXCLUDED_CAPABILITIES = Object.freeze({
  entity_delete:
    'Deletion is limited by entity type and deleted entities can be reindexed; use the New Relic UI/Terraform.',
  service_level_delete: 'No supported public service-level delete mutation is documented.',
  api_key_create: 'Creation returns secret-bearing key material.',
  synthetic_secure_credential_mutation:
    'Secure credential values must never transit MCP tool arguments or results.',
  live_dashboard_sharing: 'Live-dashboard URLs and passwords are secret-bearing.',
  historical_export_download: 'Historical export responses can contain presigned URLs.',
  slack_destination_create: 'Slack destinations require OAuth in the New Relic UI.',
  access_grant_update:
    'Current public examples use an inline updateAccessOptions shape, but the stable generated client exposes no input contract; use New Relic UI/Terraform until a supported type is published.',
  entity_golden_data_override:
    'The current generated client exposes golden-data reads but no stable override mutation/input contract; the older public example uses a different context/domainType signature.',
} as const);

export const TOOL_CATALOG: readonly InternalToolSpec[] = Object.freeze([
  ...coreSpecs,
  ...telemetrySpecs,
  ...entitySpecs,
  ...alertSpecs,
  ...dashboardSpecs,
  ...syntheticSpecs,
  ...workloadSpecs,
  ...serviceLevelSpecs,
  ...logSpecs,
  ...metricSpecs,
  ...adminSpecs,
]);

const duplicateToolNames = TOOL_CATALOG.map(({ name }) => name).filter(
  (name, index, names) => names.indexOf(name) !== index,
);
if (duplicateToolNames.length > 0) {
  throw new TypeError(
    `Duplicate tool names in capability catalog: ${duplicateToolNames.join(', ')}`,
  );
}

export const ALL_TOOL_NAMES: readonly string[] = Object.freeze(
  TOOL_CATALOG.map(({ name }) => name),
);

export function catalogByToolset(): Readonly<Record<ToolsetName, readonly string[]>> {
  return Object.fromEntries(
    (
      [
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
      ] as const
    ).map((toolset) => [
      toolset,
      TOOL_CATALOG.filter((spec) => spec.toolset === toolset).map(({ name }) => name),
    ]),
  ) as unknown as Record<ToolsetName, readonly string[]>;
}
