import { z } from 'zod';

import {
  accountIdSchema,
  cursorSchema,
  dashboardInputSchema,
  graphQlDataSchema,
  guidSchema,
  pipelineDeleteNrqlSchema,
  readOnlyConfigurationNrqlSchema,
  validateDashboardNrql,
} from './schemas.js';
import { defineOperation, type NerdGraphOperation } from './types.js';
import { queryResponseSchema } from './query-response-schema.js';
import { containsSecretBearingUrl } from '../security/redaction.js';

const SOURCES = {
  nerdGraph:
    'https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/',
  nrql: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/',
  asyncNrql: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/async-queries-nrql-tutorial/',
  entities:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-entities-api-tutorial/',
  tags: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-tagging-entities/',
  golden: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-golden-metrics/',
  traces:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-distributed-trace-data-tutorial/',
  alerts: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-api-alerts-policies/',
  conditions:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-api-nrql-condition-alerts/',
  muting: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-api-muting-rules/',
  notifications:
    'https://docs.newrelic.com/docs/alerts/get-notified/notification-integrations/notification-api/',
  issues: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github/',
  dashboards: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-dashboards/',
  synthetics: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/synthetics-api/overview/',
  workloads:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-workloads-api-tutorials/',
  serviceLevels: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-slm/',
  maintenance:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-maintenance-windows-slm/',
  logs: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-log-parsing-rules-tutorial/',
  logPartitions:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-data-partition-rules-tutorial/',
  logObfuscation: 'https://docs.newrelic.com/docs/logs/ui-data/obfuscation-ui/',
  metrics:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-metric-normalization-rule/',
  pipeline: 'https://docs.newrelic.com/docs/new-relic-control/pipeline-control/',
  admin: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-manage-groups/',
  dataAccess:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-data-access-control/',
  accounts: 'https://docs.newrelic.com/docs/apis/nerdgraph/examples/manage-accounts-nerdgraph/',
  apiKeys:
    'https://docs.newrelic.com/docs/apis/nerdgraph/examples/use-nerdgraph-manage-license-keys-user-keys/',
} as const;

function op(options: {
  name: string;
  kind: 'query' | 'mutation';
  document: string;
  sourceUrl: string;
  variablesSchema: z.ZodType<Record<string, unknown>>;
  responseSchema?: z.ZodType<unknown>;
  complexNrql?: boolean;
  cacheable?: boolean;
  experimentalHeader?: string;
}): NerdGraphOperation {
  const responseSchema =
    options.kind === 'query'
      ? queryResponseSchema(options.document)
      : (options.responseSchema ?? graphQlDataSchema);
  return defineOperation({
    name: options.name,
    kind: options.kind,
    document: options.document,
    sourceUrl: options.sourceUrl,
    operationName: options.name,
    variablesSchema: options.variablesSchema,
    dataSchema: responseSchema,
    responseSchema,
    ...(options.complexNrql === undefined ? {} : { complexNrql: options.complexNrql }),
    ...(options.cacheable === undefined ? {} : { cacheable: options.cacheable }),
    ...(options.experimentalHeader === undefined
      ? {}
      : { experimentalHeader: options.experimentalHeader }),
  });
}

export const CONNECTION_CHECK = op({
  name: 'ConnectionCheck',
  kind: 'query',
  sourceUrl: SOURCES.nerdGraph,
  variablesSchema: z.object({}).strict(),
  document: `query ConnectionCheck {
    actor { user { id } accounts { id name } }
  }`,
});

export const ACCOUNTS_LIST = op({
  name: 'AccountsList',
  kind: 'query',
  sourceUrl: SOURCES.nerdGraph,
  variablesSchema: z.object({}).strict(),
  cacheable: true,
  document: `query AccountsList {
    actor { accounts { id name } }
  }`,
});

export const ACCOUNT_ACCESS = op({
  name: 'AccountAccess',
  kind: 'query',
  sourceUrl: SOURCES.nerdGraph,
  variablesSchema: z.object({ accountId: accountIdSchema }).strict(),
  cacheable: true,
  document: `query AccountAccess($accountId: Int!) {
    actor { account(id: $accountId) { id name } }
  }`,
});

export const NRQL_QUERY = op({
  name: 'NrqlQuery',
  kind: 'query',
  sourceUrl: SOURCES.nrql,
  variablesSchema: z
    .object({ accountId: accountIdSchema, nrql: z.string().min(1).max(16_384) })
    .strict(),
  complexNrql: true,
  document: `query NrqlQuery($accountId: Int!, $nrql: Nrql!) {
    actor { account(id: $accountId) { id nrql(query: $nrql) { results metadata { eventTypes facets timeWindow { begin end } } } } }
  }`,
});

export const NRQL_ASYNC_START = op({
  name: 'NrqlAsyncStart',
  kind: 'query',
  sourceUrl: SOURCES.asyncNrql,
  variablesSchema: z
    .object({ accountId: accountIdSchema, nrql: z.string().min(1).max(16_384) })
    .strict(),
  complexNrql: true,
  document: `query NrqlAsyncStart($accountId: Int!, $nrql: Nrql!) {
    actor { account(id: $accountId) { id nrql(query: $nrql, async: true) { results queryProgress { queryId completed retryAfter retryDeadline resultExpiration } } } }
  }`,
});

export const NRQL_ASYNC_STATUS = op({
  name: 'NrqlAsyncStatus',
  kind: 'query',
  sourceUrl: SOURCES.asyncNrql,
  variablesSchema: z
    .object({ accountId: accountIdSchema, queryId: z.string().min(1).max(512) })
    .strict(),
  document: `query NrqlAsyncStatus($accountId: Int!, $queryId: ID!) {
    actor { account(id: $accountId) { id nrqlQueryProgress(queryId: $queryId) { results queryProgress { queryId completed retryAfter retryDeadline resultExpiration } } } }
  }`,
});

export const NRQL_ASYNC_CANCEL = op({
  name: 'NrqlAsyncCancel',
  kind: 'mutation',
  sourceUrl: SOURCES.asyncNrql,
  variablesSchema: z.object({ queryId: z.string().min(1).max(512) }).strict(),
  responseSchema: z.looseObject({
    nrqlCancelQuery: z.looseObject({
      queryId: z.string().min(1),
      requestStatus: z.string().min(1),
      rejectionReason: z.string().nullable().optional(),
    }),
  }),
  document: `mutation NrqlAsyncCancel($queryId: ID!) {
    nrqlCancelQuery(queryId: $queryId) { queryId requestStatus rejectionReason }
  }`,
});

export const ENTITY_SEARCH = op({
  name: 'EntitySearch',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  document: `query EntitySearch($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name domain type accountId alertSeverity reporting tags { key values } } } } }
  }`,
});

export const ENTITY_GET = op({
  name: 'EntityGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query EntityGet($guid: EntityGuid!) {
    actor { entity(guid: $guid) { guid name domain type accountId alertSeverity reporting permalink tags { key values } ... on GenericEntity { metadata { key value } } } }
  }`,
});

/** Targeted ownership lookup used before cross-entity writes. */
export const ENTITIES_GET = op({
  name: 'EntitiesGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z.object({ guids: z.array(guidSchema).max(25) }).strict(),
  document: `query EntitiesGet($guids: [EntityGuid]!) {
    actor { entities(guids: $guids) { guid name domain type accountId } }
  }`,
});

/** Verify both ends of a relationship belong to authorized accounts. */
export const ENTITY_PAIR_GET = op({
  name: 'EntityPairGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z.object({ sourceGuid: guidSchema, targetGuid: guidSchema }).strict(),
  document: `query EntityPairGet($sourceGuid: EntityGuid!, $targetGuid: EntityGuid!) {
    actor {
      source: entity(guid: $sourceGuid) { guid name domain type accountId }
      target: entity(guid: $targetGuid) { guid name domain type accountId }
    }
  }`,
});

/** Verify a target entity and a bounded set of related entity inputs. */
export const TARGET_AND_ENTITIES_GET = op({
  name: 'TargetAndEntitiesGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z
    .object({ targetGuid: guidSchema, guids: z.array(guidSchema).max(25) })
    .strict(),
  document: `query TargetAndEntitiesGet($targetGuid: EntityGuid!, $guids: [EntityGuid]!) {
    actor {
      target: entity(guid: $targetGuid) { guid name domain type accountId }
      entities(guids: $guids) { guid name domain type accountId }
    }
  }`,
});

/** Verify an account and every explicitly assigned entity before account-scoped creation. */
export const ACCOUNT_AND_ENTITIES_GET = op({
  name: 'AccountAndEntitiesGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z
    .object({ accountId: accountIdSchema, guids: z.array(guidSchema).max(25) })
    .strict(),
  document: `query AccountAndEntitiesGet($accountId: Int!, $guids: [EntityGuid]!) {
    actor {
      account(id: $accountId) { id name }
      entities(guids: $guids) { guid name domain type accountId }
    }
  }`,
});

/** Verify a source entity and destination account before duplication/copy operations. */
export const ENTITY_AND_ACCOUNT_GET = op({
  name: 'EntityAndAccountGet',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z.object({ guid: guidSchema, accountId: accountIdSchema }).strict(),
  document: `query EntityAndAccountGet($guid: EntityGuid!, $accountId: Int!) {
    actor {
      entity(guid: $guid) { guid name domain type accountId }
      account(id: $accountId) { id name }
    }
  }`,
});

export const ENTITY_RELATIONSHIPS = op({
  name: 'EntityRelationships',
  kind: 'query',
  sourceUrl: SOURCES.entities,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query EntityRelationships($guid: EntityGuid!) {
    actor { entity(guid: $guid) { guid accountId relatedEntities { results { source { entity { guid name domain type accountId } } target { entity { guid name domain type accountId } } type } } } }
  }`,
});

export const ENTITY_GOLDEN_DATA = op({
  name: 'EntityGoldenData',
  kind: 'query',
  sourceUrl: SOURCES.golden,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query EntityGoldenData($guid: EntityGuid!) {
    actor { entity(guid: $guid) { guid accountId goldenMetrics { metrics { name title unit query } } goldenTags { tags { key } } } }
  }`,
});

export const TRACE_GET = op({
  name: 'TraceGet',
  kind: 'query',
  sourceUrl: SOURCES.traces,
  variablesSchema: z.object({ traceId: z.string().min(1).max(256) }).strict(),
  document: `query TraceGet($traceId: String!) {
    actor { distributedTracing { trace(traceId: $traceId) { id timestamp durationMs entityCount entities { guid name domain type accountId } spanConnections { parent child } spans { id traceId parentId name timestamp durationMs entityGuid clientType processBoundary attributes spanAnomalies { anomalousValue anomalyType averageMeasure } } } } }
  }`,
});

export const ALERT_POLICIES_LIST = op({
  name: 'AlertPoliciesList',
  kind: 'query',
  sourceUrl: SOURCES.alerts,
  variablesSchema: z
    .object({ accountId: accountIdSchema, cursor: cursorSchema.optional() })
    .strict(),
  document: `query AlertPoliciesList($accountId: Int!, $cursor: String) {
    actor { account(id: $accountId) { id alerts { policiesSearch(cursor: $cursor) { nextCursor totalCount policies { id name incidentPreference } } } } }
  }`,
});

export const ALERT_POLICY_GET = op({
  name: 'AlertPolicyGet',
  kind: 'query',
  sourceUrl: SOURCES.alerts,
  variablesSchema: z.object({ accountId: accountIdSchema, id: z.string().min(1) }).strict(),
  document: `query AlertPolicyGet($accountId: Int!, $id: ID!) {
    actor { account(id: $accountId) { id alerts { policy(id: $id) { id name incidentPreference } } } }
  }`,
});

export const ALERT_CONDITIONS_LIST = op({
  name: 'AlertConditionsList',
  kind: 'query',
  sourceUrl: SOURCES.conditions,
  variablesSchema: z
    .object({
      accountId: accountIdSchema,
      policyId: z.string().optional(),
      cursor: cursorSchema.optional(),
    })
    .strict(),
  document: `query AlertConditionsList($accountId: Int!, $policyId: ID, $cursor: String) {
    actor { account(id: $accountId) { id alerts { nrqlConditionsSearch(searchCriteria: { policyId: $policyId }, cursor: $cursor) { nextCursor totalCount nrqlConditions { id name enabled policyId type nrql { query } } } } } }
  }`,
});

export const ALERT_CONDITION_GET = op({
  name: 'AlertConditionGet',
  kind: 'query',
  sourceUrl: SOURCES.conditions,
  variablesSchema: z.object({ accountId: accountIdSchema, id: z.string().min(1) }).strict(),
  document: `query AlertConditionGet($accountId: Int!, $id: ID!) {
    actor { account(id: $accountId) { id alerts { nrqlCondition(id: $id) { id name enabled policyId type nrql { query } runbookUrl violationTimeLimitSeconds } } } }
  }`,
});

export const MUTING_RULES_LIST = op({
  name: 'MutingRulesList',
  kind: 'query',
  sourceUrl: SOURCES.muting,
  variablesSchema: z
    .object({ accountId: accountIdSchema, cursor: cursorSchema.optional() })
    .strict(),
  document: `query MutingRulesList($accountId: Int!, $cursor: String) {
    actor { account(id: $accountId) { id alerts { mutingRules(cursor: $cursor) { nextCursor rules { id name enabled description schedule { startTime endTime timeZone repeat } condition { operator conditions { attribute operator values } } } } } } }
  }`,
});

export const NOTIFICATIONS_LIST = op({
  name: 'NotificationsList',
  kind: 'query',
  sourceUrl: SOURCES.notifications,
  variablesSchema: z
    .object({
      accountId: accountIdSchema,
      destinationCursor: cursorSchema.optional(),
      channelCursor: cursorSchema.optional(),
      workflowCursor: cursorSchema.optional(),
    })
    .strict(),
  document: `query NotificationsList($accountId: Int!, $destinationCursor: String, $channelCursor: String, $workflowCursor: String) {
    actor { account(id: $accountId) { id aiNotifications { destinations(cursor: $destinationCursor) { nextCursor entities { id name type status } } channels(cursor: $channelCursor) { nextCursor entities { id name type destinationId status } } } aiWorkflows { workflows(cursor: $workflowCursor) { nextCursor entities { id name workflowEnabled lastRun } } } } }
  }`,
});

export const DASHBOARDS_LIST = op({
  name: 'DashboardsList',
  kind: 'query',
  sourceUrl: SOURCES.dashboards,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  document: `query DashboardsList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId permalink tags { key values } } } } }
  }`,
});

export const DASHBOARD_GET = op({
  name: 'DashboardGet',
  kind: 'query',
  sourceUrl: SOURCES.dashboards,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query DashboardGet($guid: EntityGuid!) {
    actor { entity(guid: $guid) { ... on DashboardEntity { guid name accountId description permissions pages { guid name description widgets { id title visualization { id } layout { column row height width } rawConfiguration } } variables { name title type defaultValues { value } } } } }
  }`,
});

export const SYNTHETIC_MONITORS_LIST = op({
  name: 'SyntheticMonitorsList',
  kind: 'query',
  sourceUrl: SOURCES.synthetics,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  document: `query SyntheticMonitorsList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId domain type tags { key values } ... on SyntheticMonitorEntityOutline { monitorType } } } } }
  }`,
});

export const SYNTHETIC_MONITOR_GET = op({
  name: 'SyntheticMonitorGet',
  kind: 'query',
  sourceUrl: SOURCES.synthetics,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query SyntheticMonitorGet($guid: EntityGuid!) {
    actor { entity(guid: $guid) { ... on SyntheticMonitorEntity { guid name accountId monitorType monitoredUrl period monitorSummary { status locationsFailing locationsRunning successRate } tags { key values } } } }
  }`,
});

export const SYNTHETIC_LOCATIONS_LIST = op({
  name: 'SyntheticLocationsList',
  kind: 'query',
  sourceUrl: SOURCES.synthetics,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  cacheable: true,
  document: `query SyntheticLocationsList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId domain type tags { key values } } } } }
  }`,
});

export const SYNTHETIC_DOWNTIMES_LIST = op({
  name: 'SyntheticDowntimesList',
  kind: 'query',
  sourceUrl: SOURCES.synthetics,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  document: `query SyntheticDowntimesList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId domain type tags { key values } } } } }
  }`,
});

export const SYNTHETIC_SECURE_CREDENTIALS_LIST = op({
  name: 'SyntheticSecureCredentialsList',
  kind: 'query',
  sourceUrl: SOURCES.synthetics,
  variablesSchema: z
    .object({ query: z.string().min(1).max(4096), cursor: cursorSchema.optional() })
    .strict(),
  document: `query SyntheticSecureCredentialsList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId domain type tags { key values } } } } }
  }`,
});

export const WORKLOADS_LIST = op({
  name: 'WorkloadsList',
  kind: 'query',
  sourceUrl: SOURCES.workloads,
  variablesSchema: z.object({ query: z.string().min(1), cursor: cursorSchema.optional() }).strict(),
  document: `query WorkloadsList($query: String!, $cursor: String) {
    actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { guid name accountId permalink } } } }
  }`,
});

export const WORKLOAD_GET = op({
  name: 'WorkloadGet',
  kind: 'query',
  sourceUrl: SOURCES.workloads,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query WorkloadGet($guid: EntityGuid!) {
    actor { entity(guid: $guid) { guid name accountId permalink ... on AlertableEntity { alertSeverity } ... on CollectionEntity { collection(name: "WORKLOAD") { members { count results { entities { accountId entityType name guid ... on AlertableEntityOutline { alertSeverity } } } } } } } }
  }`,
});

/** Verify an existing workload and every explicitly assigned member in one pre-read. */
export const WORKLOAD_WRITE_PREREAD = op({
  name: 'WorkloadWritePreread',
  kind: 'query',
  sourceUrl: SOURCES.workloads,
  variablesSchema: z
    .object({ guid: guidSchema, entityGuids: z.array(guidSchema).max(25) })
    .strict(),
  document: `query WorkloadWritePreread($guid: EntityGuid!, $entityGuids: [EntityGuid]!) {
    actor {
      workload: entity(guid: $guid) { guid name accountId }
      members: entities(guids: $entityGuids) { guid name accountId }
    }
  }`,
});

export const WORKLOAD_STATUS_GET = op({
  name: 'WorkloadStatusGet',
  kind: 'query',
  sourceUrl: SOURCES.workloads,
  variablesSchema: z.object({ guid: guidSchema }).strict(),
  document: `query WorkloadStatusGet($guid: EntityGuid!) {
    actor { entity(guid: $guid) { ... on WorkloadEntity { guid name accountId workloadStatus { statusValue } } } }
  }`,
});

export const SERVICE_LEVELS_LIST = op({
  name: 'ServiceLevelsList',
  kind: 'query',
  sourceUrl: SOURCES.serviceLevels,
  variablesSchema: z.object({ entityGuid: guidSchema }).strict(),
  document: `query ServiceLevelsList($entityGuid: EntityGuid!) {
    actor { entity(guid: $entityGuid) { guid name accountId serviceLevel { indicators { id name description entityGuid createdAt events { account { id } badEvents { from where } goodEvents { from where } validEvents { from where } } objectives { target timeWindow { rolling { count unit } } } } } } }
  }`,
});

export const SERVICE_LEVEL_GET = op({
  name: 'ServiceLevelGet',
  kind: 'query',
  sourceUrl: SOURCES.serviceLevels,
  variablesSchema: z.object({ entityGuid: guidSchema }).strict(),
  document: `query ServiceLevelGet($entityGuid: EntityGuid!) {
    actor { entity(guid: $entityGuid) { guid name accountId serviceLevel { indicators { id name description entityGuid createdAt events { account { id } badEvents { from where } goodEvents { from where } validEvents { from where } } objectives { target timeWindow { rolling { count unit } } } } } } }
  }`,
});

export const SERVICE_LEVEL_RESULTS = op({
  name: 'ServiceLevelResults',
  kind: 'query',
  sourceUrl: SOURCES.serviceLevels,
  variablesSchema: z
    .object({ accountId: accountIdSchema, nrql: z.string().min(1).max(16_384) })
    .strict(),
  complexNrql: true,
  document: `query ServiceLevelResults($accountId: Int!, $nrql: Nrql!) {
    actor { account(id: $accountId) { id nrql(query: $nrql) { results metadata { timeWindow { begin end } } } } }
  }`,
});

export const MAINTENANCE_WINDOWS_LIST = op({
  name: 'MaintenanceWindowsList',
  kind: 'query',
  sourceUrl: SOURCES.maintenance,
  variablesSchema: z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).strict(),
  document: `query MaintenanceWindowsList($ids: [ID!]!) {
    actor { maintenanceWindow { listByIds(ids: $ids) { maintenanceWindows { id name description scope { id type } startTime duration rrule timezone affectedEntityType affectedEntities metadata { createdAt createdBy { id } updatedAt updatedBy { id } } } } } }
  }`,
});

/** Targeted maintenance-window lookup plus ownership checks for affected entities. */
export const MAINTENANCE_WINDOW_AND_ENTITIES = op({
  name: 'MaintenanceWindowAndEntities',
  kind: 'query',
  sourceUrl: SOURCES.maintenance,
  variablesSchema: z
    .object({ ids: z.array(z.string().min(1)).length(1), guids: z.array(guidSchema).max(25) })
    .strict(),
  document: `query MaintenanceWindowAndEntities($ids: [ID!]!, $guids: [EntityGuid]!) {
    actor {
      maintenanceWindow { listByIds(ids: $ids) { maintenanceWindows { id name scope { id type } } } }
      entities(guids: $guids) { guid name domain type accountId }
    }
  }`,
});

export const LOG_CONFIGURATIONS_LIST = op({
  name: 'LogConfigurationsList',
  kind: 'query',
  sourceUrl: SOURCES.logs,
  variablesSchema: z.object({ accountId: accountIdSchema }).strict(),
  document: `query LogConfigurationsList($accountId: Int!) {
    actor { account(id: $accountId) { id logConfigurations { dataPartitionRules { id description enabled matchingCriteria { attributeName matchingExpression matchingOperator } nrql retentionPolicy targetDataPartition } parsingRules { id description enabled grok lucene nrql attribute } obfuscationExpressions { id name description regex } obfuscationRules { id name description enabled filter actions { id method attributes expression { id name } } } } } }
  }`,
});

export const METRIC_NORMALIZATION_RULES_LIST = op({
  name: 'MetricNormalizationRulesList',
  kind: 'query',
  sourceUrl: SOURCES.metrics,
  variablesSchema: z
    .object({ accountId: accountIdSchema, enabled: z.boolean().optional() })
    .strict(),
  document: `query MetricNormalizationRulesList($accountId: Int!, $enabled: Boolean) {
    actor { account(id: $accountId) { id metricNormalization { metricNormalizationRules(enabled: $enabled) { id action applicationGuid applicationName createdAt enabled evalOrder matchExpression notes replacement terminateChain } } } }
  }`,
});

export const PIPELINE_RULES_LIST = op({
  name: 'PipelineRulesList',
  kind: 'query',
  sourceUrl: SOURCES.pipeline,
  variablesSchema: z.object({ query: z.string().min(1).max(4096) }).strict(),
  document: `query PipelineRulesList($query: String!) {
    actor { entityManagement { entitySearch(query: $query) { entities { id type ... on EntityManagementPipelineCloudRuleEntity { id name description nrql enabled scope { id type } metadata { createdAt createdBy { id } } } } } } }
  }`,
});

export const ORGANIZATION_GET = op({
  name: 'OrganizationGet',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z.object({}).strict(),
  document: `query OrganizationGet {
    actor { organization { id name } }
  }`,
});

export const ADMIN_RESOURCES_LIST = op({
  name: 'AdminResourcesList',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({
      organizationId: z.string().min(1),
      authenticationDomainCursor: cursorSchema.optional(),
      groupCursor: cursorSchema.optional(),
      grantCursor: cursorSchema.optional(),
      roleCursor: cursorSchema.optional(),
      dataAccessPolicyCursor: cursorSchema.optional(),
      permissionCursor: cursorSchema.optional(),
    })
    .strict(),
  document: `query AdminResourcesList($organizationId: ID!, $authenticationDomainCursor: String, $groupCursor: String, $grantCursor: String, $roleCursor: String, $dataAccessPolicyCursor: String, $permissionCursor: String) {
    customerAdministration {
      authenticationDomains(cursor: $authenticationDomainCursor, filter: { organizationId: { eq: $organizationId } }) { items { id name organizationId provisioningType authenticationType } nextCursor }
      groups(cursor: $groupCursor, filter: { organizationId: { eq: $organizationId } }) { items { id name authenticationDomainId } nextCursor totalCount }
      grants(cursor: $grantCursor, filter: { organizationId: { eq: $organizationId } }) { items { id dataAccessPolicy { id name } grantee { id type } group { id } role { id name } scope { id type typev2 } } nextCursor totalCount }
      roles(cursor: $roleCursor, filter: { organizationId: { eq: $organizationId } }) { items { id name scope type } nextCursor totalCount }
      dataAccessPolicies(cursor: $dataAccessPolicyCursor, filter: { organizationId: { eq: $organizationId } }) { items { id name policy status version } nextCursor totalCount }
      permissions(cursor: $permissionCursor) { items { category feature id name product } nextCursor }
    }
  }`,
});

export const ADMIN_USERS_LIST = op({
  name: 'AdminUsersList',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({ authenticationDomainId: z.string().min(1), cursor: cursorSchema.optional() })
    .strict(),
  document: `query AdminUsersList($authenticationDomainId: ID!, $cursor: String) {
    customerAdministration { users(cursor: $cursor, filter: { authenticationDomainId: { eq: $authenticationDomainId } }) { items { authenticationDomainId email emailVerificationState id lastActive name timeZone type { id name } } nextCursor totalCount } }
  }`,
});

export const ADMIN_GROUPS_LIST = op({
  name: 'AdminGroupsList',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({ organizationId: z.string().min(1), cursor: cursorSchema.optional() })
    .strict(),
  document: `query AdminGroupsList($organizationId: ID!, $cursor: String) {
    customerAdministration { groups(cursor: $cursor, filter: { organizationId: { eq: $organizationId } }) { items { id name authenticationDomainId } nextCursor totalCount } }
  }`,
});

export const ADMIN_ROLES_LIST = op({
  name: 'AdminRolesList',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({
      organizationId: z.string().min(1),
      roleCursor: cursorSchema.optional(),
      permissionCursor: cursorSchema.optional(),
    })
    .strict(),
  document: `query AdminRolesList($organizationId: ID!, $roleCursor: String, $permissionCursor: String) {
    customerAdministration {
      roles(cursor: $roleCursor, filter: { organizationId: { eq: $organizationId } }) { items { id name scope type } nextCursor totalCount }
      permissions(cursor: $permissionCursor) { items { category feature id name product } nextCursor }
    }
  }`,
});

export const ADMIN_GRANTS_LIST = op({
  name: 'AdminGrantsList',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({ organizationId: z.string().min(1), cursor: cursorSchema.optional() })
    .strict(),
  document: `query AdminGrantsList($organizationId: ID!, $cursor: String) {
    customerAdministration { grants(cursor: $cursor, filter: { organizationId: { eq: $organizationId } }) { items { id dataAccessPolicy { id name } grantee { id type } group { id } role { id name } scope { id type typev2 } } nextCursor totalCount } }
  }`,
});

export const ADMIN_DATA_ACCESS_POLICIES_LIST = op({
  name: 'AdminDataAccessPoliciesList',
  kind: 'query',
  sourceUrl: SOURCES.dataAccess,
  variablesSchema: z
    .object({ organizationId: z.string().min(1), cursor: cursorSchema.optional() })
    .strict(),
  document: `query AdminDataAccessPoliciesList($organizationId: ID!, $cursor: String) {
    customerAdministration { dataAccessPolicies(cursor: $cursor, filter: { organizationId: { eq: $organizationId } }) { items { id name policy status version } nextCursor totalCount } }
  }`,
});

/** Exact user lookup avoids first-page false negatives during admin writes. */
export const ADMIN_USER_GET = op({
  name: 'AdminUserGet',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({ authenticationDomainId: z.string().min(1), id: z.string().min(1) })
    .strict(),
  document: `query AdminUserGet($authenticationDomainId: ID!, $id: ID!) {
    customerAdministration { users(filter: { authenticationDomainId: { eq: $authenticationDomainId }, id: { eq: $id } }) { items { authenticationDomainId email id name timeZone type { id name } } } }
  }`,
});

/** Exact organization-resource lookup; unused filters receive impossible sentinels. */
export const ADMIN_TARGETS_GET = op({
  name: 'AdminTargetsGet',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({
      organizationId: z.string().min(1),
      authenticationDomainId: z.string().min(1),
      groupId: z.string().min(1),
      roleId: z.number().int(),
    })
    .strict(),
  document: `query AdminTargetsGet($organizationId: ID!, $authenticationDomainId: ID!, $groupId: ID!, $roleId: Int!) {
    customerAdministration {
      authenticationDomains(filter: { organizationId: { eq: $organizationId }, id: { eq: $authenticationDomainId } }) { items { id name organizationId } }
      groups(filter: { organizationId: { eq: $organizationId }, id: { eq: $groupId } }) { items { id name authenticationDomainId } }
      roles(filter: { organizationId: { eq: $organizationId }, id: { eq: $roleId } }) { items { id name scope type } }
      dataAccessPolicies(filter: { organizationId: { eq: $organizationId } }) { items { id name policy status version } }
    }
  }`,
});

/** Targeted organization/authentication-domain lookup for membership changes. */
export const ADMIN_MEMBERSHIP_PREREAD = op({
  name: 'AdminMembershipPreread',
  kind: 'query',
  sourceUrl: SOURCES.admin,
  variablesSchema: z
    .object({
      organizationId: z.string().min(1),
      authenticationDomainId: z.string().min(1),
      groupId: z.string().min(1),
      userId: z.string().min(1),
    })
    .strict(),
  document: `query AdminMembershipPreread($organizationId: ID!, $authenticationDomainId: ID!, $groupId: ID!, $userId: ID!) {
    customerAdministration {
      groups(filter: { organizationId: { eq: $organizationId }, id: { eq: $groupId } }) { items { id name authenticationDomainId } }
      users(filter: { authenticationDomainId: { eq: $authenticationDomainId }, id: { eq: $userId } }) { items { id name email authenticationDomainId } }
    }
  }`,
});

export const API_KEYS_LIST = op({
  name: 'ApiKeysList',
  kind: 'query',
  sourceUrl: SOURCES.apiKeys,
  variablesSchema: z.object({ accountId: accountIdSchema }).strict(),
  document: `query ApiKeysList($accountId: Int!) {
    actor { account(id: $accountId) { id name } apiAccess { keySearch(query: { types: [INGEST, USER], scope: { accountIds: [$accountId] } }) { keys { id name notes type ... on ApiAccessIngestKey { accountId ingestType } ... on ApiAccessUserKey { accountId userId } } } } }
  }`,
});

const mutationIdSchema = z.string().min(1).max(8192);
const inputStringSchema = z.string().max(1_000_000);
const tagInputSchema = z
  .object({ key: z.string().min(1).max(255), values: z.array(z.string()).min(1).max(100) })
  .strict();
const policyInputSchema = z
  .object({
    name: z.string().min(1).max(255),
    incidentPreference: z.enum(['PER_POLICY', 'PER_CONDITION', 'PER_CONDITION_AND_TARGET']),
  })
  .strict();
const policyUpdateInputSchema = policyInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'policy update must not be empty');
const nrqlTermSchema = z
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
const nrqlConditionExpirationSchema = z
  .object({
    expirationDuration: z.number().int().positive().nullable().optional(),
    closeViolationsOnExpiration: z.boolean().optional(),
    openViolationOnExpiration: z.boolean().optional(),
    ignoreOnExpectedTermination: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'expiration must not be empty');
const nrqlConditionSignalSchema = z
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
const nrqlConditionSchema = z
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
    terms: z.array(nrqlTermSchema).min(1).max(2),
    violationTimeLimitSeconds: z.number().int().positive().optional(),
    expiration: nrqlConditionExpirationSchema.optional(),
    signal: nrqlConditionSignalSchema.optional(),
    titleTemplate: z.string().max(4000).nullable().optional(),
    targetEntity: guidSchema.nullable().optional(),
  })
  .strict();
const nrqlConditionUpdateSchema = nrqlConditionSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'condition update must not be empty');
const mutingConditionSchema = z
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
  .strict();
const mutingRuleSchema = z
  .object({
    actionOnMutingRuleWindowEnded: z.enum(['ACTIVATE', 'CLOSE_ISSUES']).optional(),
    condition: z
      .object({
        operator: z.enum(['AND', 'OR']),
        conditions: z.array(mutingConditionSchema).min(1).max(100),
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
      .optional(),
  })
  .strict();
const notificationPropertySchema = z
  .object({
    key: z
      .string()
      .min(1)
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
const notificationDestinationSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/^SLACK(?:_LEGACY)?$/iu.test(value), 'Slack requires the New Relic UI'),
    properties: z.array(notificationPropertySchema).max(100).optional(),
  })
  .strict();
const notificationDestinationUpdateSchema = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    properties: z.array(notificationPropertySchema).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'destination update must not be empty');
const notificationChannelSchema = z
  .object({
    destinationId: mutationIdSchema,
    name: z.string().min(1).max(255),
    product: z.string().min(1).max(128),
    properties: z.array(notificationPropertySchema).max(100).optional(),
    type: z.string().min(1).max(128),
  })
  .strict();
const notificationChannelUpdateSchema = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    properties: z.array(notificationPropertySchema).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'channel update must not be empty');
const workflowPredicateSchema = z
  .object({
    attribute: z.string().min(1).max(255),
    operator: z.string().min(1).max(128),
    values: z.array(z.string()).max(100),
  })
  .strict();
const workflowDestinationSchema = z
  .object({
    channelId: mutationIdSchema,
    notificationTriggers: z.array(z.string().min(1)).min(1).max(20),
    updateOriginalMessage: z.boolean().optional(),
  })
  .strict();
const workflowFilterSchema = z
  .object({
    name: z.string().max(255).optional(),
    predicates: z.array(workflowPredicateSchema).max(100).optional(),
    type: z.enum(['FILTER', 'VIEW']),
  })
  .strict();
const workflowNrqlEnrichmentSchema = z
  .object({
    id: mutationIdSchema.optional(),
    name: z.string().min(1).max(255),
    configuration: z
      .array(z.object({ query: readOnlyConfigurationNrqlSchema }).strict())
      .min(1)
      .max(100),
  })
  .strict();
const workflowEnrichmentsSchema = z
  .object({ nrql: z.array(workflowNrqlEnrichmentSchema).max(100) })
  .strict();
const workflowMutingHandlingSchema = z.enum([
  'DONT_NOTIFY_FULLY_MUTED_ISSUES',
  'DONT_NOTIFY_FULLY_OR_PARTIALLY_MUTED_ISSUES',
  'NOTIFY_ALL_ISSUES',
]);
const workflowCreateSchema = z
  .object({
    destinationConfigurations: z.array(workflowDestinationSchema).max(100).optional(),
    destinationsEnabled: z.boolean(),
    enrichments: workflowEnrichmentsSchema.optional(),
    enrichmentsEnabled: z.boolean(),
    issuesFilter: workflowFilterSchema,
    mutingRulesHandling: workflowMutingHandlingSchema,
    name: z.string().min(1).max(255),
    workflowEnabled: z.boolean(),
  })
  .strict();
const workflowUpdateSchema = z
  .object({
    id: mutationIdSchema,
    destinationConfigurations: z.array(workflowDestinationSchema).max(100).optional(),
    destinationsEnabled: z.boolean().optional(),
    enrichments: workflowEnrichmentsSchema.optional(),
    enrichmentsEnabled: z.boolean().optional(),
    issuesFilter: z
      .object({ id: mutationIdSchema.optional(), filterInput: workflowFilterSchema })
      .strict()
      .optional(),
    mutingRulesHandling: workflowMutingHandlingSchema.optional(),
    name: z.string().min(1).max(255).optional(),
    workflowEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'workflow update must not be empty');
const dashboardPageInputSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    widgets: z.array(z.record(z.string(), z.unknown())).max(1000),
  })
  .strict()
  .superRefine(validateDashboardNrql);
const dashboardWidgetUpdateSchema = z
  .object({
    id: mutationIdSchema,
    title: z.string().max(255).optional(),
    visualization: z
      .object({ id: z.string().min(1) })
      .strict()
      .optional(),
    layout: z
      .object({
        column: z.number().int().nonnegative(),
        row: z.number().int().nonnegative(),
        height: z.number().int().positive(),
        width: z.number().int().positive(),
      })
      .strict()
      .optional(),
    rawConfiguration: z
      .record(z.string(), z.unknown())
      .superRefine(validateDashboardNrql)
      .optional(),
  })
  .strict();
const syntheticPeriodSchema = z.enum([
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
const syntheticCommonFields = {
  name: z.string().min(1).max(255),
  period: syntheticPeriodSchema,
  status: z.enum(['ENABLED', 'DISABLED']),
  apdexTarget: z.number().positive().optional(),
  tags: z.array(tagInputSchema).max(100).optional(),
};
const syntheticStandardLocationsSchema = z
  .object({
    public: z.array(z.string().min(1)).min(1).max(100).optional(),
    private: z.array(guidSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => value.public !== undefined || value.private !== undefined,
    'at least one location is required',
  );
const syntheticScriptedLocationsSchema = z
  .object({
    public: z.array(z.string().min(1)).min(1).max(100).optional(),
    private: z
      .array(z.object({ guid: guidSchema }).strict())
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.public !== undefined || value.private !== undefined,
    'at least one location is required',
  );
const syntheticBrowserRuntimeSchema = z
  .object({
    runtimeType: z.literal('CHROME_BROWSER'),
    runtimeTypeVersion: z.string().min(1).max(64),
    scriptLanguage: z.literal('JAVASCRIPT'),
  })
  .strict();
const syntheticStepRuntimeSchema = syntheticBrowserRuntimeSchema.omit({ scriptLanguage: true });
const syntheticApiRuntimeSchema = z
  .object({
    runtimeType: z.literal('NODE_API'),
    runtimeTypeVersion: z.string().min(1).max(64),
    scriptLanguage: z.literal('JAVASCRIPT'),
  })
  .strict();
const syntheticNodeRuntimeSchema = syntheticApiRuntimeSchema.omit({ scriptLanguage: true });
const syntheticCustomHeaderSchema = z
  .object({ name: z.string().min(1).max(255), value: z.string().max(8192) })
  .strict();
const syntheticDeviceEmulationSchema = z
  .object({
    deviceType: z.enum(['MOBILE', 'TABLET', 'NONE']),
    deviceOrientation: z.enum(['LANDSCAPE', 'PORTRAIT', 'NONE']),
  })
  .strict();
const syntheticSimpleAdvancedSchema = z
  .object({
    customHeaders: z.array(syntheticCustomHeaderSchema).max(100).optional(),
    redirectIsFailure: z.boolean().optional(),
    responseValidationText: z.string().max(16_384).optional(),
    shouldBypassHeadRequest: z.boolean().optional(),
    useTlsValidation: z.boolean().optional(),
  })
  .strict();
const syntheticBrowserAdvancedSchema = z
  .object({
    customHeaders: z.array(syntheticCustomHeaderSchema).max(100).optional(),
    deviceEmulation: syntheticDeviceEmulationSchema.optional(),
    enableScreenshotOnFailureAndScript: z.boolean().optional(),
    responseValidationText: z.string().max(16_384).optional(),
    useTlsValidation: z.boolean().optional(),
  })
  .strict();
const syntheticScriptBrowserAdvancedSchema = z
  .object({
    deviceEmulation: syntheticDeviceEmulationSchema.optional(),
    enableScreenshotOnFailureAndScript: z.boolean().optional(),
  })
  .strict();
const syntheticStepAdvancedSchema = z
  .object({ enableScreenshotOnFailureAndScript: z.boolean().optional() })
  .strict();
const syntheticBrowsersSchema = z
  .array(z.enum(['CHROME', 'FIREFOX']))
  .min(1)
  .max(10);
const syntheticDevicesSchema = z
  .array(
    z.enum([
      'DESKTOP',
      'MOBILE_LANDSCAPE',
      'MOBILE_PORTRAIT',
      'TABLET_LANDSCAPE',
      'TABLET_PORTRAIT',
    ]),
  )
  .min(1)
  .max(10);
const syntheticSimpleSchema = z
  .object({
    ...syntheticCommonFields,
    locations: syntheticStandardLocationsSchema,
    uri: z.url().max(4096),
    advancedOptions: syntheticSimpleAdvancedSchema.optional(),
  })
  .strict();
const syntheticSimpleBrowserSchema = z
  .object({
    ...syntheticCommonFields,
    browsers: syntheticBrowsersSchema,
    devices: syntheticDevicesSchema,
    locations: syntheticStandardLocationsSchema,
    runtime: syntheticBrowserRuntimeSchema,
    uri: z.url().max(4096),
    advancedOptions: syntheticBrowserAdvancedSchema.optional(),
  })
  .strict();
const syntheticScriptBrowserSchema = z
  .object({
    ...syntheticCommonFields,
    browsers: syntheticBrowsersSchema,
    devices: syntheticDevicesSchema,
    locations: syntheticScriptedLocationsSchema,
    runtime: syntheticBrowserRuntimeSchema,
    script: inputStringSchema.min(1),
    advancedOptions: syntheticScriptBrowserAdvancedSchema.optional(),
  })
  .strict();
const syntheticScriptApiSchema = z
  .object({
    ...syntheticCommonFields,
    locations: syntheticScriptedLocationsSchema,
    runtime: syntheticApiRuntimeSchema,
    script: inputStringSchema.min(1),
  })
  .strict();
const syntheticStepSchema = z
  .object({
    ...syntheticCommonFields,
    browsers: syntheticBrowsersSchema,
    devices: syntheticDevicesSchema,
    locations: syntheticScriptedLocationsSchema,
    runtime: syntheticStepRuntimeSchema,
    steps: z
      .array(
        z
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
          .strict(),
      )
      .min(1)
      .max(100),
    advancedOptions: syntheticStepAdvancedSchema.optional(),
  })
  .strict();
const syntheticCertificateSchema = z
  .object({
    ...syntheticCommonFields,
    locations: syntheticStandardLocationsSchema,
    domain: z.string().min(1).max(2048),
    numberDaysToFailBeforeCertExpires: z.number().int().positive().max(3650),
    runtime: syntheticNodeRuntimeSchema.optional(),
  })
  .strict();
const syntheticBrokenLinkSchema = z
  .object({
    ...syntheticCommonFields,
    locations: syntheticStandardLocationsSchema,
    uri: z.url().max(4096),
    runtime: syntheticNodeRuntimeSchema.optional(),
  })
  .strict();
const monitorUpdateSchema = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'monitor update must not be empty');
const naiveDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u);
const downtimeEndRepeatSchema = z
  .object({
    onDate: naiveDateTimeSchema.optional(),
    onRepeat: z.number().int().positive().optional(),
  })
  .strict();
const downtimeFrequencySchema = z
  .object({
    daysOfMonth: z.array(z.number().int().min(1).max(31)).max(31).optional(),
    daysOfWeek: z
      .object({ ordinalDayOfMonth: z.string().min(1), weekDay: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const workloadInputSchema = z
  .object({
    name: z.string().min(1).max(255),
    entityGuids: z.array(guidSchema).max(2000).optional(),
    entitySearchQueries: z
      .array(z.object({ id: mutationIdSchema.optional(), query: z.string().min(1) }).strict())
      .max(100)
      .optional(),
    scopeAccounts: z.object({ accountIds: z.array(accountIdSchema).min(1).max(100) }).strict(),
  })
  .strict();
const serviceLevelObjectiveSchema = z
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
const serviceLevelEventSelectSchema = z
  .object({
    function: z.enum(['COUNT', 'SUM', 'GET_FIELD', 'GET_CDF_COUNT']),
    attribute: z.string().min(1).max(4096).optional(),
    threshold: z.number().optional(),
  })
  .strict();
const serviceLevelEventQuerySchema = z
  .object({
    from: z.string().min(1).max(4096),
    where: z.string().min(1).max(16_384).optional(),
    select: serviceLevelEventSelectSchema.optional(),
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
const serviceLevelEventsCreateSchema = z
  .object({
    accountId: accountIdSchema,
    validEvents: serviceLevelEventQuerySchema,
    goodEvents: serviceLevelEventQuerySchema.optional(),
    badEvents: serviceLevelEventQuerySchema.optional(),
  })
  .strict()
  .refine(
    ({ goodEvents, badEvents }) => (goodEvents === undefined) !== (badEvents === undefined),
    'exactly one of goodEvents or badEvents is required',
  );
const serviceLevelEventsUpdateSchema = z
  .object({
    validEvents: serviceLevelEventQuerySchema.optional(),
    goodEvents: serviceLevelEventQuerySchema.optional(),
    badEvents: serviceLevelEventQuerySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'events update must not be empty');
const serviceLevelIndicatorCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    events: serviceLevelEventsCreateSchema,
    objectives: z.array(serviceLevelObjectiveSchema).min(1).max(100),
  })
  .strict();
const serviceLevelIndicatorUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(4000).optional(),
    events: serviceLevelEventsUpdateSchema.optional(),
    objectives: z.array(serviceLevelObjectiveSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'indicator update must not be empty');
const maintenanceWindowSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    scope: z.object({ id: mutationIdSchema, type: z.literal('ACCOUNT') }).strict(),
    startTime: z.string().min(1),
    duration: z.string().min(1),
    rrule: z.string().max(4096).optional(),
    timezone: z.string().min(1).max(255),
    affectedEntityType: z.literal('SERVICE_LEVEL'),
    affectedEntities: z.array(guidSchema).max(2000).optional(),
  })
  .strict();
const maintenanceWindowUpdateSchema = maintenanceWindowSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'maintenance window update must not be empty');
const logMatchingCriteriaSchema = z
  .object({
    attributeName: z.string().min(1).max(255),
    matchingExpression: z.string().min(1).max(16_384),
    matchingMethod: z.string().min(1).max(64),
  })
  .strict();
const logPartitionCreateSchema = z
  .object({
    description: z.string().max(1000).optional(),
    enabled: z.boolean(),
    matchingCriteria: logMatchingCriteriaSchema.optional(),
    nrql: readOnlyConfigurationNrqlSchema.optional(),
    retentionPolicy: z.enum(['STANDARD', 'SECONDARY']),
    targetDataPartition: z.string().min(1).max(255),
  })
  .strict();
const logPartitionUpdateSchema = logPartitionCreateSchema.extend({ id: mutationIdSchema });
const logParsingSchema = z
  .object({
    attribute: z.string().min(1).max(255).optional(),
    description: z.string().max(1000),
    enabled: z.boolean(),
    grok: z.string().min(1).max(32_768),
    lucene: z.string().min(1).max(16_384),
    nrql: readOnlyConfigurationNrqlSchema,
  })
  .strict();
const logObfuscationExpressionCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    regex: z.string().min(1).max(16_384),
  })
  .strict();
const logObfuscationExpressionUpdateSchema = logObfuscationExpressionCreateSchema.extend({
  id: mutationIdSchema,
});
const logObfuscationActionSchema = z
  .object({
    attributes: z.array(z.string().min(1)).max(100),
    expressionId: mutationIdSchema,
    method: z.enum(['HASH_SHA256', 'MASK']),
  })
  .strict();
const logObfuscationRuleCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    enabled: z.boolean(),
    filter: z.string().min(1).max(16_384),
    actions: z.array(logObfuscationActionSchema).min(1).max(100),
  })
  .strict();
const logObfuscationRuleUpdateSchema = logObfuscationRuleCreateSchema.extend({
  id: mutationIdSchema,
});
const metricRuleSchema = z
  .object({
    id: z.number().int().positive().optional(),
    action: z.enum(['REPLACE', 'IGNORE', 'DENY_NEW_METRICS']),
    applicationGuid: guidSchema.optional(),
    enabled: z.boolean(),
    evalOrder: z.number().int().positive(),
    matchExpression: z.string().min(2).max(16_384),
    notes: z.string().max(4000).optional(),
    replacement: z.string().max(16_384).optional(),
    terminateChain: z.boolean(),
  })
  .strict();
const pipelineScopeSchema = z.object({ id: mutationIdSchema, type: z.literal('ACCOUNT') }).strict();
const pipelineRuleCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().min(1).max(4000),
    nrql: pipelineDeleteNrqlSchema,
    enabled: z.boolean().optional(),
    scope: pipelineScopeSchema,
  })
  .strict();
const pipelineRuleUpdateSchema = pipelineRuleCreateSchema.omit({ scope: true }).extend({
  enabled: z.boolean(),
});
const accountCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    regionCode: z.enum(['us01', 'eu01']).optional(),
  })
  .strict();
const accountUpdateSchema = z
  .object({ id: accountIdSchema, name: z.string().min(1).max(255) })
  .strict();
const authorizationGranteeSchema = z
  .object({
    id: mutationIdSchema,
    type: z.enum(['GROUP', 'ORGANIZATION', 'SYSTEM_IDENTITY', 'SYSTEM_IDENTITY_GROUP', 'USER']),
  })
  .strict();
const accountAccessGrantSchema = z
  .object({
    accountId: accountIdSchema,
    dataAccessPolicyId: mutationIdSchema.optional(),
    roleId: mutationIdSchema,
  })
  .strict();
const entityAccessGrantSchema = z
  .object({
    entity: z.object({ id: mutationIdSchema, type: z.string().min(1) }).strict(),
    iamParent: z
      .object({ id: mutationIdSchema, scope: z.enum(['ACCOUNT', 'ORGANIZATION']) })
      .strict(),
    roleId: mutationIdSchema,
  })
  .strict();
const groupAccessGrantSchema = z
  .object({ groupId: mutationIdSchema, roleId: mutationIdSchema })
  .strict();
const organizationAccessGrantSchema = z.object({ roleId: mutationIdSchema }).strict();
export const authorizationAccessSchema = z
  .object({
    accountAccessGrants: z.array(accountAccessGrantSchema).max(100).optional(),
    entityAccessGrants: z.array(entityAccessGrantSchema).max(100).optional(),
    grantee: authorizationGranteeSchema.optional(),
    groupAccessGrants: z.array(groupAccessGrantSchema).max(100).optional(),
    groupId: mutationIdSchema.optional(),
    organizationAccessGrants: z.array(organizationAccessGrantSchema).max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.accountAccessGrants !== undefined ||
      value.entityAccessGrants !== undefined ||
      value.groupAccessGrants !== undefined ||
      value.organizationAccessGrants !== undefined,
    'at least one access grant is required',
  );
const dataPolicyDocumentSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            operations: z.array(z.string().min(1)).min(1),
            eventTypes: z
              .object({ allow: z.array(z.string()), except: z.array(z.string()) })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const GRAPHQL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = Object.freeze({
  EntityRelationshipEdgeType: z.enum([
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
  ]),
  TaggingTagInput: tagInputSchema,
  AlertsPolicyInput: policyInputSchema,
  AlertsPolicyUpdateInput: policyUpdateInputSchema,
  AlertsNrqlConditionStaticInput: nrqlConditionSchema,
  AlertsNrqlConditionUpdateStaticInput: nrqlConditionUpdateSchema,
  AlertsMutingRuleInput: mutingRuleSchema,
  AlertsMutingRuleUpdateInput: mutingRuleSchema,
  AiNotificationsDestinationInput: notificationDestinationSchema,
  AiNotificationsDestinationUpdate: notificationDestinationUpdateSchema,
  AiNotificationsChannelInput: notificationChannelSchema,
  AiNotificationsChannelUpdate: notificationChannelUpdateSchema,
  AiWorkflowsCreateWorkflowInput: workflowCreateSchema,
  AiWorkflowsUpdateWorkflowInput: workflowUpdateSchema,
  DashboardInput: dashboardInputSchema,
  DashboardUpdatePageInput: dashboardPageInputSchema,
  DashboardUpdateWidgetInput: dashboardWidgetUpdateSchema,
  SyntheticsCreateSimpleMonitorInput: syntheticSimpleSchema,
  SyntheticsCreateSimpleBrowserMonitorInput: syntheticSimpleBrowserSchema,
  SyntheticsCreateScriptBrowserMonitorInput: syntheticScriptBrowserSchema,
  SyntheticsCreateScriptApiMonitorInput: syntheticScriptApiSchema,
  SyntheticsCreateStepMonitorInput: syntheticStepSchema,
  SyntheticsCreateCertCheckMonitorInput: syntheticCertificateSchema,
  SyntheticsCreateBrokenLinksMonitorInput: syntheticBrokenLinkSchema,
  SyntheticsUpdateSimpleMonitorInput: monitorUpdateSchema(syntheticSimpleSchema),
  SyntheticsUpdateSimpleBrowserMonitorInput: monitorUpdateSchema(syntheticSimpleBrowserSchema),
  SyntheticsUpdateScriptBrowserMonitorInput: monitorUpdateSchema(syntheticScriptBrowserSchema),
  SyntheticsUpdateScriptApiMonitorInput: monitorUpdateSchema(syntheticScriptApiSchema),
  SyntheticsUpdateStepMonitorInput: monitorUpdateSchema(syntheticStepSchema),
  SyntheticsUpdateCertCheckMonitorInput: monitorUpdateSchema(syntheticCertificateSchema),
  SyntheticsUpdateBrokenLinksMonitorInput: monitorUpdateSchema(syntheticBrokenLinkSchema),
  SyntheticsDateWindowEndConfig: downtimeEndRepeatSchema,
  SyntheticsMonitorDowntimeWeekDays: z.enum([
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ]),
  SyntheticsMonitorDowntimeMonthlyFrequency: downtimeFrequencySchema,
  SyntheticsMonitorDowntimeOnceConfig: z
    .object({
      timezone: z.string().min(1),
      startTime: naiveDateTimeSchema,
      endTime: naiveDateTimeSchema,
    })
    .strict(),
  SyntheticsMonitorDowntimeDailyConfig: z
    .object({
      timezone: z.string().min(1),
      startTime: naiveDateTimeSchema,
      endTime: naiveDateTimeSchema,
      endRepeat: downtimeEndRepeatSchema.optional(),
    })
    .strict(),
  SyntheticsMonitorDowntimeWeeklyConfig: z
    .object({
      timezone: z.string().min(1),
      startTime: naiveDateTimeSchema,
      endTime: naiveDateTimeSchema,
      endRepeat: downtimeEndRepeatSchema.optional(),
      maintenanceDays: z.array(z.string().min(1)).min(1).max(7),
    })
    .strict(),
  SyntheticsMonitorDowntimeMonthlyConfig: z
    .object({
      timezone: z.string().min(1),
      startTime: naiveDateTimeSchema,
      endTime: naiveDateTimeSchema,
      endRepeat: downtimeEndRepeatSchema.optional(),
      frequency: downtimeFrequencySchema,
    })
    .strict(),
  WorkloadCreateInput: workloadInputSchema,
  WorkloadUpdateInput: workloadInputSchema,
  WorkloadDuplicateInput: z.object({ name: z.string().min(1).max(255) }).strict(),
  ServiceLevelIndicatorCreateInput: serviceLevelIndicatorCreateSchema,
  ServiceLevelIndicatorUpdateInput: serviceLevelIndicatorUpdateSchema,
  MaintenanceWindowInput: maintenanceWindowSchema,
  MaintenanceWindowUpdateInput: maintenanceWindowUpdateSchema,
  LogConfigurationsCreateDataPartitionRuleInput: logPartitionCreateSchema,
  LogConfigurationsUpdateDataPartitionRuleInput: logPartitionUpdateSchema,
  LogConfigurationsParsingRuleConfiguration: logParsingSchema,
  LogConfigurationsCreateObfuscationExpressionInput: logObfuscationExpressionCreateSchema,
  LogConfigurationsUpdateObfuscationExpressionInput: logObfuscationExpressionUpdateSchema,
  LogConfigurationsCreateObfuscationRuleInput: logObfuscationRuleCreateSchema,
  LogConfigurationsUpdateObfuscationRuleInput: logObfuscationRuleUpdateSchema,
  MetricNormalizationRuleInput: metricRuleSchema,
  EntityManagementPipelineCloudRuleEntityCreateInput: pipelineRuleCreateSchema,
  EntityManagementPipelineCloudRuleEntityUpdateInput: pipelineRuleUpdateSchema,
  AccountManagementCreateInput: accountCreateSchema,
  AccountManagementUpdateInput: accountUpdateSchema,
  UserManagementRequestedTierName: z.enum(['FULL_USER_TIER', 'CORE_USER_TIER', 'BASIC_USER_TIER']),
  AuthorizationManagementGrantAccess: authorizationAccessSchema,
  AuthorizationManagementRevokeAccess: authorizationAccessSchema,
  DataAccessPolicyRawDocument: dataPolicyDocumentSchema,
});

function schemaForGraphQlType(typeReference: string): z.ZodType<unknown> {
  const required = typeReference.endsWith('!');
  const core = required ? typeReference.slice(0, -1) : typeReference;
  let schema: z.ZodType<unknown>;
  if (core.startsWith('[') && core.endsWith(']')) {
    schema = z.array(schemaForGraphQlType(core.slice(1, -1)));
  } else if (core === 'Int') {
    schema = z.number().int();
  } else if (core === 'Float') {
    schema = z.number();
  } else if (core === 'Boolean') {
    schema = z.boolean();
  } else if (core === 'ID') {
    // GraphQL ID inputs accept either string or integer literals/variables.
    schema = z.union([z.string().min(1), z.number().int()]);
  } else if (core === 'String' || core === 'EntityGuid' || core === 'Nrql') {
    schema = z.string().min(1);
  } else if (core === 'NaiveDateTime') {
    schema = naiveDateTimeSchema;
  } else {
    const registered = GRAPHQL_INPUT_SCHEMAS[core];
    if (registered === undefined) {
      throw new TypeError(`No typed Zod input schema is registered for GraphQL type ${core}`);
    }
    schema = registered;
  }
  return required ? schema : schema.optional();
}

function mutationVariablesSchema(variableDeclarations: string): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const match of variableDeclarations.matchAll(
    /\$([_A-Za-z][_0-9A-Za-z]*)\s*:\s*(\[[^\]]+\]|[_A-Za-z][_0-9A-Za-z]*!?)(!?)/gu,
  )) {
    const [, name, baseType, trailingRequired] = match;
    if (name === undefined || baseType === undefined) continue;
    shape[name] = schemaForGraphQlType(`${baseType}${trailingRequired ?? ''}`);
  }
  if (Object.keys(shape).length === 0 && variableDeclarations !== '') {
    throw new TypeError(`Unable to parse GraphQL variable declarations: ${variableDeclarations}`);
  }
  return z.object(shape).strict();
}

type SelectionTree = ReadonlyMap<string, SelectionTree | undefined>;

function mutationSelection(body: string): SelectionTree {
  const rootArgumentsEnd = /\)\s*\{/u.exec(body);
  if (rootArgumentsEnd === null) {
    throw new TypeError(`Unable to locate mutation response selection: ${body}`);
  }
  const start = rootArgumentsEnd.index + rootArgumentsEnd[0].lastIndexOf('{') + 1;

  function parseBlock(offset: number): { readonly fields: SelectionTree; readonly end: number } {
    const fields = new Map<string, SelectionTree | undefined>();
    let index = offset;
    while (index < body.length) {
      while (/[,\s]/u.test(body[index] ?? '')) index += 1;
      if (body[index] === '}') return { fields, end: index + 1 };
      const match = /^[_A-Za-z][_0-9A-Za-z]*/u.exec(body.slice(index));
      if (match === null) {
        throw new TypeError(`Unable to parse mutation selection near: ${body.slice(index)}`);
      }
      const field = match[0];
      index += field.length;
      while (/\s/u.test(body[index] ?? '')) index += 1;
      if (body[index] === '{') {
        const nested = parseBlock(index + 1);
        fields.set(field, nested.fields);
        index = nested.end;
      } else {
        fields.set(field, undefined);
      }
    }
    throw new TypeError(`Unterminated mutation response selection: ${body}`);
  }

  return parseBlock(start).fields;
}

const MUTATION_OBJECT_LIST_FIELDS = new Set([
  'accessGrants',
  'actions',
  'daysOfWeek',
  'deletedKeys',
  'errors',
  'groups',
  'roles',
  'updatedKeys',
]);
const MUTATION_SCALAR_LIST_FIELDS = new Set([
  'attributes',
  'daysOfMonth',
  'ids',
  'maintenanceDays',
  'monitorGuids',
]);
const MUTATION_BOOLEAN_FIELDS = new Set([
  'enabled',
  'isCanceled',
  'shared',
  'verifiedScriptExecution',
  'workflowEnabled',
]);
const MUTATION_NUMBER_FIELDS = new Set([
  'accountId',
  'evalOrder',
  'numberDaysToFailBeforeCertExpires',
  'onRepeat',
  'version',
]);

function mutationScalarSchema(field: string): z.ZodType<unknown> {
  if (MUTATION_SCALAR_LIST_FIELDS.has(field)) {
    return z.array(z.union([z.string(), z.number(), z.boolean()])).nullable();
  }
  if (MUTATION_BOOLEAN_FIELDS.has(field)) return z.boolean().nullable();
  if (MUTATION_NUMBER_FIELDS.has(field)) return z.number().nullable();
  if (field === 'policy') {
    return z.union([z.looseObject({}), z.array(z.unknown()), z.string(), z.null()]);
  }
  if (/(?:^id$|Id$|Guid$|^guid$)/u.test(field)) {
    return z.union([z.string().min(1), z.number().int(), z.null()]);
  }
  return z.string().min(1).nullable();
}

function hasMutationOutcome(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'object') return true;
  return Object.values(value).some((child) => hasMutationOutcome(child));
}

function mutationObjectSchema(
  selection: SelectionTree,
  requireOutcome = false,
): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [field, nested] of selection) {
    if (nested === undefined) {
      shape[field] = mutationScalarSchema(field);
      continue;
    }
    const child = mutationObjectSchema(nested);
    if (field === 'errors') {
      shape[field] = z.array(child);
    } else if (MUTATION_OBJECT_LIST_FIELDS.has(field)) {
      shape[field] = z.array(child).nullable();
    } else {
      shape[field] = z.union([child, z.null()]);
    }
  }
  const schema = z.looseObject(shape);
  if (!requireOutcome) return schema;
  const outcomeFields = [...selection.keys()].filter(
    (field) => field !== 'error' && field !== 'errors',
  );
  if (outcomeFields.length === 0) return schema;
  return schema.superRefine((value, context) => {
    if (!outcomeFields.some((field) => hasMutationOutcome(value[field]))) {
      context.addIssue({
        code: 'custom',
        message: 'mutation response did not contain a successful outcome',
      });
    }
  });
}

/**
 * Mutations use documented field and input-type names. Inputs are parsed by the
 * owning tool schema before reaching these operations; the executor performs a
 * second variables parse via each operation's schema.
 */
function mutation(options: {
  name: string;
  sourceUrl: string;
  variableDeclarations: string;
  body: string;
  experimentalHeader?: string;
  rootFields?: readonly string[];
}): NerdGraphOperation {
  const inferredRoot = /^\s*([_A-Za-z][_0-9A-Za-z]*)\s*\(/u.exec(options.body)?.[1];
  const rootFields = options.rootFields ?? (inferredRoot === undefined ? [] : [inferredRoot]);
  if (rootFields.length === 0) {
    throw new TypeError(`${options.name} must declare at least one response root field`);
  }
  const rootSelection = mutationSelection(options.body);
  const responseSchema = z.looseObject(
    Object.fromEntries(
      rootFields.map((field) => [field, mutationObjectSchema(rootSelection, true)]),
    ),
  );
  return op({
    name: options.name,
    kind: 'mutation',
    sourceUrl: options.sourceUrl,
    variablesSchema: mutationVariablesSchema(options.variableDeclarations),
    responseSchema,
    ...(options.experimentalHeader === undefined
      ? {}
      : { experimentalHeader: options.experimentalHeader }),
    document: `mutation ${options.name}${options.variableDeclarations} { ${options.body} }`,
  });
}

export const MUTATIONS = {
  entityTagsAdd: mutation({
    name: 'EntityTagsAdd',
    sourceUrl: SOURCES.tags,
    variableDeclarations: '($guid: EntityGuid!, $tags: [TaggingTagInput!]!)',
    body: 'taggingAddTagsToEntity(guid: $guid, tags: $tags) { errors { message type } }',
  }),
  entityTagsRemove: mutation({
    name: 'EntityTagsRemove',
    sourceUrl: SOURCES.tags,
    variableDeclarations: '($guid: EntityGuid!, $tagKeys: [String!]!)',
    body: 'taggingDeleteTagFromEntity(guid: $guid, tagKeys: $tagKeys) { errors { message type } }',
  }),
  entityTagsReplace: mutation({
    name: 'EntityTagsReplace',
    sourceUrl: SOURCES.tags,
    variableDeclarations: '($guid: EntityGuid!, $tags: [TaggingTagInput!]!)',
    body: 'taggingReplaceTagsOnEntity(guid: $guid, tags: $tags) { errors { message type } }',
  }),
  entityRelationshipPut: mutation({
    name: 'EntityRelationshipPut',
    sourceUrl: SOURCES.entities,
    variableDeclarations:
      '($sourceGuid: EntityGuid!, $targetGuid: EntityGuid!, $type: EntityRelationshipEdgeType!)',
    body: 'entityRelationshipUserDefinedCreateOrReplace(sourceEntityGuid: $sourceGuid, targetEntityGuid: $targetGuid, type: $type) { errors { message type } }',
  }),
  entityRelationshipDelete: mutation({
    name: 'EntityRelationshipDelete',
    sourceUrl: SOURCES.entities,
    variableDeclarations:
      '($sourceGuid: EntityGuid!, $targetGuid: EntityGuid!, $type: EntityRelationshipEdgeType)',
    body: 'entityRelationshipUserDefinedDelete(sourceEntityGuid: $sourceGuid, targetEntityGuid: $targetGuid, type: $type) { errors { message type } }',
  }),
  alertPolicyCreate: mutation({
    name: 'AlertPolicyCreate',
    sourceUrl: SOURCES.alerts,
    variableDeclarations: '($accountId: Int!, $policy: AlertsPolicyInput!)',
    body: 'alertsPolicyCreate(accountId: $accountId, policy: $policy) { id name incidentPreference }',
  }),
  alertPolicyUpdate: mutation({
    name: 'AlertPolicyUpdate',
    sourceUrl: SOURCES.alerts,
    variableDeclarations: '($accountId: Int!, $id: ID!, $policy: AlertsPolicyUpdateInput!)',
    body: 'alertsPolicyUpdate(accountId: $accountId, id: $id, policy: $policy) { id name incidentPreference }',
  }),
  alertPolicyDelete: mutation({
    name: 'AlertPolicyDelete',
    sourceUrl: SOURCES.alerts,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'alertsPolicyDelete(accountId: $accountId, id: $id) { id }',
  }),
  alertConditionCreate: mutation({
    name: 'AlertConditionCreate',
    sourceUrl: SOURCES.conditions,
    variableDeclarations:
      '($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!)',
    body: 'alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) { id name enabled policyId }',
  }),
  alertConditionUpdate: mutation({
    name: 'AlertConditionUpdate',
    sourceUrl: SOURCES.conditions,
    variableDeclarations:
      '($accountId: Int!, $id: ID!, $condition: AlertsNrqlConditionUpdateStaticInput!)',
    body: 'alertsNrqlConditionStaticUpdate(accountId: $accountId, id: $id, condition: $condition) { id name enabled policyId }',
  }),
  alertConditionDelete: mutation({
    name: 'AlertConditionDelete',
    sourceUrl: SOURCES.conditions,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'alertsConditionDelete(accountId: $accountId, id: $id) { id }',
  }),
  mutingRuleCreate: mutation({
    name: 'MutingRuleCreate',
    sourceUrl: SOURCES.muting,
    variableDeclarations: '($accountId: Int!, $rule: AlertsMutingRuleInput!)',
    body: 'alertsMutingRuleCreate(accountId: $accountId, rule: $rule) { id name enabled }',
  }),
  mutingRuleUpdate: mutation({
    name: 'MutingRuleUpdate',
    sourceUrl: SOURCES.muting,
    variableDeclarations: '($accountId: Int!, $id: ID!, $rule: AlertsMutingRuleUpdateInput!)',
    body: 'alertsMutingRuleUpdate(accountId: $accountId, id: $id, rule: $rule) { id name enabled }',
  }),
  mutingRuleDelete: mutation({
    name: 'MutingRuleDelete',
    sourceUrl: SOURCES.muting,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'alertsMutingRuleDelete(accountId: $accountId, id: $id) { id }',
  }),
  issueAcknowledge: mutation({
    name: 'IssueAcknowledge',
    sourceUrl: SOURCES.issues,
    variableDeclarations: '($accountId: Int!, $issueId: ID!)',
    body: 'aiIssuesAcknowledgeIssue(accountId: $accountId, issueId: $issueId) { issue { issueId state } }',
    experimentalHeader: 'AiIssues',
  }),
  issueUnacknowledge: mutation({
    name: 'IssueUnacknowledge',
    sourceUrl: SOURCES.issues,
    variableDeclarations: '($accountId: Int!, $issueId: ID!)',
    body: 'aiIssuesUnacknowledgeIssue(accountId: $accountId, issueId: $issueId) { issue { issueId state } }',
    experimentalHeader: 'AiIssues',
  }),
  issueResolve: mutation({
    name: 'IssueResolve',
    sourceUrl: SOURCES.issues,
    variableDeclarations: '($accountId: Int!, $issueId: ID!)',
    body: 'aiIssuesResolveIssue(accountId: $accountId, issueId: $issueId) { issue { issueId state } }',
    experimentalHeader: 'AiIssues',
  }),

  notificationDestinationCreate: mutation({
    name: 'NotificationDestinationCreate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $destination: AiNotificationsDestinationInput!)',
    body: 'aiNotificationsCreateDestination(accountId: $accountId, destination: $destination) { destination { id name type status } error { details } }',
  }),
  notificationDestinationUpdate: mutation({
    name: 'NotificationDestinationUpdate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations:
      '($accountId: Int!, $id: ID!, $destination: AiNotificationsDestinationUpdate!)',
    body: 'aiNotificationsUpdateDestination(accountId: $accountId, destinationId: $id, destination: $destination) { destination { id name type status } error { details } }',
  }),
  notificationDestinationDelete: mutation({
    name: 'NotificationDestinationDelete',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'aiNotificationsDeleteDestination(accountId: $accountId, destinationId: $id) { ids error { details } }',
  }),
  notificationChannelCreate: mutation({
    name: 'NotificationChannelCreate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $channel: AiNotificationsChannelInput!)',
    body: 'aiNotificationsCreateChannel(accountId: $accountId, channel: $channel) { channel { id name type destinationId status } error { details } }',
  }),
  notificationChannelUpdate: mutation({
    name: 'NotificationChannelUpdate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $id: ID!, $channel: AiNotificationsChannelUpdate!)',
    body: 'aiNotificationsUpdateChannel(accountId: $accountId, channelId: $id, channel: $channel) { channel { id name type destinationId status } error { details } }',
  }),
  notificationChannelDelete: mutation({
    name: 'NotificationChannelDelete',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'aiNotificationsDeleteChannel(accountId: $accountId, channelId: $id) { ids error { details } }',
  }),
  notificationWorkflowCreate: mutation({
    name: 'NotificationWorkflowCreate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations:
      '($accountId: Int!, $createWorkflowData: AiWorkflowsCreateWorkflowInput!)',
    body: 'aiWorkflowsCreateWorkflow(accountId: $accountId, createWorkflowData: $createWorkflowData) { workflow { id name workflowEnabled lastRun } errors { description type } }',
  }),
  notificationWorkflowUpdate: mutation({
    name: 'NotificationWorkflowUpdate',
    sourceUrl: SOURCES.notifications,
    variableDeclarations:
      '($accountId: Int!, $deleteUnusedChannels: Boolean!, $updateWorkflowData: AiWorkflowsUpdateWorkflowInput!)',
    body: 'aiWorkflowsUpdateWorkflow(accountId: $accountId, deleteUnusedChannels: $deleteUnusedChannels, updateWorkflowData: $updateWorkflowData) { workflow { id name workflowEnabled lastRun } errors { description type } }',
  }),
  notificationWorkflowDelete: mutation({
    name: 'NotificationWorkflowDelete',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $deleteChannels: Boolean!, $id: ID!)',
    body: 'aiWorkflowsDeleteWorkflow(accountId: $accountId, deleteChannels: $deleteChannels, id: $id) { id errors { description type } }',
  }),
  notificationTest: mutation({
    name: 'NotificationTest',
    sourceUrl: SOURCES.notifications,
    variableDeclarations: '($accountId: Int!, $channelId: ID!)',
    body: 'aiNotificationsTestChannelById(accountId: $accountId, channelId: $channelId) { details result error { details } }',
  }),

  dashboardCreate: mutation({
    name: 'DashboardCreate',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($accountId: Int!, $dashboard: DashboardInput!)',
    body: 'dashboardCreate(accountId: $accountId, dashboard: $dashboard) { entityResult { guid name } errors { description type } }',
  }),
  dashboardUpdate: mutation({
    name: 'DashboardUpdate',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($guid: EntityGuid!, $dashboard: DashboardInput!)',
    body: 'dashboardUpdate(guid: $guid, dashboard: $dashboard) { entityResult { guid name } errors { description type } }',
  }),
  dashboardPageUpdate: mutation({
    name: 'DashboardPageUpdate',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($guid: EntityGuid!, $page: DashboardUpdatePageInput!)',
    body: 'dashboardUpdatePage(guid: $guid, page: $page) { errors { description type } }',
  }),
  dashboardWidgetsUpdate: mutation({
    name: 'DashboardWidgetsUpdate',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($guid: EntityGuid!, $widgets: [DashboardUpdateWidgetInput!]!)',
    body: 'dashboardUpdateWidgetsInPage(guid: $guid, widgets: $widgets) { errors { description type } }',
  }),
  dashboardDelete: mutation({
    name: 'DashboardDelete',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'dashboardDelete(guid: $guid) { status errors { description type } }',
  }),
  dashboardUndelete: mutation({
    name: 'DashboardUndelete',
    sourceUrl: SOURCES.dashboards,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'dashboardUndelete(guid: $guid) { errors { description type } }',
  }),

  syntheticSimpleCreate: mutation({
    name: 'SyntheticSimpleCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($accountId: Int!, $monitor: SyntheticsCreateSimpleMonitorInput!)',
    body: 'syntheticsCreateSimpleMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticSimpleBrowserCreate: mutation({
    name: 'SyntheticSimpleBrowserCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $monitor: SyntheticsCreateSimpleBrowserMonitorInput!)',
    body: 'syntheticsCreateSimpleBrowserMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticScriptBrowserCreate: mutation({
    name: 'SyntheticScriptBrowserCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $monitor: SyntheticsCreateScriptBrowserMonitorInput!)',
    body: 'syntheticsCreateScriptBrowserMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticScriptApiCreate: mutation({
    name: 'SyntheticScriptApiCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($accountId: Int!, $monitor: SyntheticsCreateScriptApiMonitorInput!)',
    body: 'syntheticsCreateScriptApiMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticStepCreate: mutation({
    name: 'SyntheticStepCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($accountId: Int!, $monitor: SyntheticsCreateStepMonitorInput!)',
    body: 'syntheticsCreateStepMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticCertificateCreate: mutation({
    name: 'SyntheticCertificateCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($accountId: Int!, $monitor: SyntheticsCreateCertCheckMonitorInput!)',
    body: 'syntheticsCreateCertCheckMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period domain numberDaysToFailBeforeCertExpires } errors { description type } }',
  }),
  syntheticBrokenLinkCreate: mutation({
    name: 'SyntheticBrokenLinkCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($accountId: Int!, $monitor: SyntheticsCreateBrokenLinksMonitorInput!)',
    body: 'syntheticsCreateBrokenLinksMonitor(accountId: $accountId, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticSimpleUpdate: mutation({
    name: 'SyntheticSimpleUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!, $monitor: SyntheticsUpdateSimpleMonitorInput!)',
    body: 'syntheticsUpdateSimpleMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticSimpleBrowserUpdate: mutation({
    name: 'SyntheticSimpleBrowserUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($guid: EntityGuid!, $monitor: SyntheticsUpdateSimpleBrowserMonitorInput!)',
    body: 'syntheticsUpdateSimpleBrowserMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticScriptBrowserUpdate: mutation({
    name: 'SyntheticScriptBrowserUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($guid: EntityGuid!, $monitor: SyntheticsUpdateScriptBrowserMonitorInput!)',
    body: 'syntheticsUpdateScriptBrowserMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticScriptApiUpdate: mutation({
    name: 'SyntheticScriptApiUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!, $monitor: SyntheticsUpdateScriptApiMonitorInput!)',
    body: 'syntheticsUpdateScriptApiMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticStepUpdate: mutation({
    name: 'SyntheticStepUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!, $monitor: SyntheticsUpdateStepMonitorInput!)',
    body: 'syntheticsUpdateStepMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period } errors { description type } }',
  }),
  syntheticCertificateUpdate: mutation({
    name: 'SyntheticCertificateUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!, $monitor: SyntheticsUpdateCertCheckMonitorInput!)',
    body: 'syntheticsUpdateCertCheckMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period domain numberDaysToFailBeforeCertExpires } errors { description type } }',
  }),
  syntheticBrokenLinkUpdate: mutation({
    name: 'SyntheticBrokenLinkUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($guid: EntityGuid!, $monitor: SyntheticsUpdateBrokenLinksMonitorInput!)',
    body: 'syntheticsUpdateBrokenLinksMonitor(guid: $guid, monitor: $monitor) { monitor { guid name status period uri } errors { description type } }',
  }),
  syntheticMonitorDelete: mutation({
    name: 'SyntheticMonitorDelete',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'syntheticsDeleteMonitor(guid: $guid) { deletedGuid }',
  }),
  syntheticPrivateLocationCreate: mutation({
    name: 'SyntheticPrivateLocationCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $name: String!, $description: String, $shared: Boolean, $verifiedScriptExecution: Boolean!)',
    body: 'syntheticsCreatePrivateLocation(accountId: $accountId, name: $name, description: $description, shared: $shared, verifiedScriptExecution: $verifiedScriptExecution) { guid errors { description type } }',
  }),
  syntheticPrivateLocationUpdate: mutation({
    name: 'SyntheticPrivateLocationUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($guid: EntityGuid!, $description: String, $shared: Boolean, $verifiedScriptExecution: Boolean)',
    body: 'syntheticsUpdatePrivateLocation(guid: $guid, description: $description, shared: $shared, verifiedScriptExecution: $verifiedScriptExecution) { guid description shared verifiedScriptExecution errors { description type } }',
  }),
  syntheticPrivateLocationDelete: mutation({
    name: 'SyntheticPrivateLocationDelete',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'syntheticsDeletePrivateLocation(guid: $guid) { errors { description type } }',
  }),
  syntheticDowntimeOnceCreate: mutation({
    name: 'SyntheticDowntimeOnceCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $name: String!, $monitorGuids: [EntityGuid], $timezone: String!, $startTime: NaiveDateTime!, $endTime: NaiveDateTime!)',
    body: 'syntheticsCreateOnceMonitorDowntime(accountId: $accountId, name: $name, monitorGuids: $monitorGuids, timezone: $timezone, startTime: $startTime, endTime: $endTime) { guid accountId name monitorGuids timezone startTime endTime }',
  }),
  syntheticDowntimeDailyCreate: mutation({
    name: 'SyntheticDowntimeDailyCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $name: String!, $monitorGuids: [EntityGuid], $timezone: String!, $startTime: NaiveDateTime!, $endTime: NaiveDateTime!, $endRepeat: SyntheticsDateWindowEndConfig)',
    body: 'syntheticsCreateDailyMonitorDowntime(accountId: $accountId, name: $name, monitorGuids: $monitorGuids, timezone: $timezone, startTime: $startTime, endTime: $endTime, endRepeat: $endRepeat) { guid accountId name monitorGuids timezone startTime endTime endRepeat { onDate onRepeat } }',
  }),
  syntheticDowntimeWeeklyCreate: mutation({
    name: 'SyntheticDowntimeWeeklyCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $name: String!, $monitorGuids: [EntityGuid], $timezone: String!, $startTime: NaiveDateTime!, $endTime: NaiveDateTime!, $maintenanceDays: [SyntheticsMonitorDowntimeWeekDays]!, $endRepeat: SyntheticsDateWindowEndConfig)',
    body: 'syntheticsCreateWeeklyMonitorDowntime(accountId: $accountId, name: $name, monitorGuids: $monitorGuids, timezone: $timezone, startTime: $startTime, endTime: $endTime, maintenanceDays: $maintenanceDays, endRepeat: $endRepeat) { guid accountId name monitorGuids timezone startTime endTime maintenanceDays endRepeat { onDate onRepeat } }',
  }),
  syntheticDowntimeMonthlyCreate: mutation({
    name: 'SyntheticDowntimeMonthlyCreate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($accountId: Int!, $name: String!, $monitorGuids: [EntityGuid], $timezone: String!, $startTime: NaiveDateTime!, $endTime: NaiveDateTime!, $frequency: SyntheticsMonitorDowntimeMonthlyFrequency!, $endRepeat: SyntheticsDateWindowEndConfig)',
    body: 'syntheticsCreateMonthlyMonitorDowntime(accountId: $accountId, name: $name, monitorGuids: $monitorGuids, timezone: $timezone, startTime: $startTime, endTime: $endTime, frequency: $frequency, endRepeat: $endRepeat) { guid accountId name monitorGuids timezone startTime endTime frequency { daysOfMonth daysOfWeek { ordinalDayOfMonth weekDay } } endRepeat { onDate onRepeat } }',
  }),
  syntheticDowntimeUpdate: mutation({
    name: 'SyntheticDowntimeUpdate',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations:
      '($guid: EntityGuid!, $name: String, $monitorGuids: [EntityGuid], $once: SyntheticsMonitorDowntimeOnceConfig, $daily: SyntheticsMonitorDowntimeDailyConfig, $weekly: SyntheticsMonitorDowntimeWeeklyConfig, $monthly: SyntheticsMonitorDowntimeMonthlyConfig)',
    body: 'syntheticsEditMonitorDowntime(guid: $guid, name: $name, monitorGuids: $monitorGuids, once: $once, daily: $daily, weekly: $weekly, monthly: $monthly) { guid accountId name monitorGuids timezone startTime endTime maintenanceDays frequency { daysOfMonth daysOfWeek { ordinalDayOfMonth weekDay } } endRepeat { onDate onRepeat } }',
  }),
  syntheticDowntimeDelete: mutation({
    name: 'SyntheticDowntimeDelete',
    sourceUrl: SOURCES.synthetics,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'syntheticsDeleteMonitorDowntime(guid: $guid) { guid }',
  }),

  workloadCreate: mutation({
    name: 'WorkloadCreate',
    sourceUrl: SOURCES.workloads,
    variableDeclarations: '($accountId: Int!, $workload: WorkloadCreateInput!)',
    body: 'workloadCreate(accountId: $accountId, workload: $workload) { guid name description permalink }',
  }),
  workloadUpdate: mutation({
    name: 'WorkloadUpdate',
    sourceUrl: SOURCES.workloads,
    variableDeclarations: '($guid: EntityGuid!, $workload: WorkloadUpdateInput!)',
    body: 'workloadUpdate(guid: $guid, workload: $workload) { guid name description permalink }',
  }),
  workloadDuplicate: mutation({
    name: 'WorkloadDuplicate',
    sourceUrl: SOURCES.workloads,
    variableDeclarations:
      '($sourceGuid: EntityGuid!, $accountId: Int!, $workload: WorkloadDuplicateInput)',
    body: 'workloadDuplicate(sourceGuid: $sourceGuid, accountId: $accountId, workload: $workload) { guid name description permalink }',
  }),
  workloadDelete: mutation({
    name: 'WorkloadDelete',
    sourceUrl: SOURCES.workloads,
    variableDeclarations: '($guid: EntityGuid!)',
    body: 'workloadDelete(guid: $guid) { guid name }',
  }),

  serviceLevelCreate: mutation({
    name: 'ServiceLevelCreate',
    sourceUrl: SOURCES.serviceLevels,
    variableDeclarations:
      '($entityGuid: EntityGuid!, $indicator: ServiceLevelIndicatorCreateInput!)',
    body: 'serviceLevelCreate(entityGuid: $entityGuid, indicator: $indicator) { id name description }',
  }),
  serviceLevelUpdate: mutation({
    name: 'ServiceLevelUpdate',
    sourceUrl: SOURCES.serviceLevels,
    variableDeclarations: '($id: ID!, $indicator: ServiceLevelIndicatorUpdateInput!)',
    body: 'serviceLevelUpdate(id: $id, indicator: $indicator) { id name description }',
  }),
  maintenanceWindowCreate: mutation({
    name: 'MaintenanceWindowCreate',
    sourceUrl: SOURCES.maintenance,
    variableDeclarations: '($maintenanceWindow: MaintenanceWindowInput!)',
    body: 'maintenanceWindowCreate(maintenanceWindow: $maintenanceWindow) { id name }',
  }),
  maintenanceWindowUpdate: mutation({
    name: 'MaintenanceWindowUpdate',
    sourceUrl: SOURCES.maintenance,
    variableDeclarations: '($id: ID!, $maintenanceWindow: MaintenanceWindowUpdateInput!)',
    body: 'maintenanceWindowUpdate(id: $id, maintenanceWindow: $maintenanceWindow) { id name }',
  }),
  maintenanceWindowDelete: mutation({
    name: 'MaintenanceWindowDelete',
    sourceUrl: SOURCES.maintenance,
    variableDeclarations: '($id: ID!)',
    body: 'maintenanceWindowDelete(id: $id) { id name }',
  }),

  logPartitionCreate: mutation({
    name: 'LogPartitionCreate',
    sourceUrl: SOURCES.logPartitions,
    variableDeclarations:
      '($accountId: Int!, $rule: LogConfigurationsCreateDataPartitionRuleInput!)',
    body: 'logConfigurationsCreateDataPartitionRule(accountId: $accountId, rule: $rule) { rule { id description enabled nrql retentionPolicy targetDataPartition } errors { message type } }',
  }),
  logPartitionUpdate: mutation({
    name: 'LogPartitionUpdate',
    sourceUrl: SOURCES.logPartitions,
    variableDeclarations:
      '($accountId: Int!, $rule: LogConfigurationsUpdateDataPartitionRuleInput)',
    body: 'logConfigurationsUpdateDataPartitionRule(accountId: $accountId, rule: $rule) { rule { id description enabled nrql retentionPolicy targetDataPartition } errors { message type } }',
  }),
  logPartitionDelete: mutation({
    name: 'LogPartitionDelete',
    sourceUrl: SOURCES.logPartitions,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'logConfigurationsDeleteDataPartitionRule(accountId: $accountId, id: $id) { errors { message type } }',
  }),
  logParsingRuleCreate: mutation({
    name: 'LogParsingRuleCreate',
    sourceUrl: SOURCES.logs,
    variableDeclarations: '($accountId: Int!, $rule: LogConfigurationsParsingRuleConfiguration!)',
    body: 'logConfigurationsCreateParsingRule(accountId: $accountId, rule: $rule) { rule { id description enabled grok lucene nrql attribute } errors { message type } }',
  }),
  logParsingRuleUpdate: mutation({
    name: 'LogParsingRuleUpdate',
    sourceUrl: SOURCES.logs,
    variableDeclarations:
      '($accountId: Int!, $id: ID!, $rule: LogConfigurationsParsingRuleConfiguration!)',
    body: 'logConfigurationsUpdateParsingRule(accountId: $accountId, id: $id, rule: $rule) { rule { id description enabled grok lucene nrql attribute } errors { message type } }',
  }),
  logParsingRuleDelete: mutation({
    name: 'LogParsingRuleDelete',
    sourceUrl: SOURCES.logs,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'logConfigurationsDeleteParsingRule(accountId: $accountId, id: $id) { errors { message type } }',
  }),
  logObfuscationExpressionCreate: mutation({
    name: 'LogObfuscationExpressionCreate',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations:
      '($accountId: Int!, $expression: LogConfigurationsCreateObfuscationExpressionInput!)',
    body: 'logConfigurationsCreateObfuscationExpression(accountId: $accountId, expression: $expression) { id name description regex }',
  }),
  logObfuscationExpressionUpdate: mutation({
    name: 'LogObfuscationExpressionUpdate',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations:
      '($accountId: Int!, $expression: LogConfigurationsUpdateObfuscationExpressionInput!)',
    body: 'logConfigurationsUpdateObfuscationExpression(accountId: $accountId, expression: $expression) { id name description regex }',
  }),
  logObfuscationExpressionDelete: mutation({
    name: 'LogObfuscationExpressionDelete',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'logConfigurationsDeleteObfuscationExpression(accountId: $accountId, id: $id) { id name description regex }',
  }),
  logObfuscationRuleCreate: mutation({
    name: 'LogObfuscationRuleCreate',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations: '($accountId: Int!, $rule: LogConfigurationsCreateObfuscationRuleInput!)',
    body: 'logConfigurationsCreateObfuscationRule(accountId: $accountId, rule: $rule) { id name description enabled filter actions { id method attributes expression { id name } } }',
  }),
  logObfuscationRuleUpdate: mutation({
    name: 'LogObfuscationRuleUpdate',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations: '($accountId: Int!, $rule: LogConfigurationsUpdateObfuscationRuleInput!)',
    body: 'logConfigurationsUpdateObfuscationRule(accountId: $accountId, rule: $rule) { id name description enabled filter actions { id method attributes expression { id name } } }',
  }),
  logObfuscationRuleDelete: mutation({
    name: 'LogObfuscationRuleDelete',
    sourceUrl: SOURCES.logObfuscation,
    variableDeclarations: '($accountId: Int!, $id: ID!)',
    body: 'logConfigurationsDeleteObfuscationRule(accountId: $accountId, id: $id) { id name description enabled filter }',
  }),

  metricNormalizationCreate: mutation({
    name: 'MetricNormalizationCreate',
    sourceUrl: SOURCES.metrics,
    variableDeclarations: '($accountId: Int!, $rule: MetricNormalizationRuleInput!)',
    body: 'metricNormalizationCreateRule(accountId: $accountId, rule: $rule) { rule { id enabled evalOrder matchExpression } errors { message type } }',
  }),
  metricNormalizationUpdate: mutation({
    name: 'MetricNormalizationUpdate',
    sourceUrl: SOURCES.metrics,
    variableDeclarations: '($accountId: Int!, $rule: MetricNormalizationRuleInput!)',
    body: 'metricNormalizationEditRule(accountId: $accountId, rule: $rule) { rule { id enabled evalOrder matchExpression } errors { message type } }',
  }),
  metricNormalizationEnable: mutation({
    name: 'MetricNormalizationEnable',
    sourceUrl: SOURCES.metrics,
    variableDeclarations: '($accountId: Int!, $ruleId: ID!)',
    body: 'metricNormalizationEnableRule(accountId: $accountId, ruleId: $ruleId) { rule { id enabled } errors { message type } }',
  }),
  metricNormalizationDisable: mutation({
    name: 'MetricNormalizationDisable',
    sourceUrl: SOURCES.metrics,
    variableDeclarations: '($accountId: Int!, $ruleId: ID!)',
    body: 'metricNormalizationDisableRule(accountId: $accountId, ruleId: $ruleId) { rule { id enabled } errors { message type } }',
  }),
  pipelineRuleCreate: mutation({
    name: 'PipelineRuleCreate',
    sourceUrl: SOURCES.pipeline,
    variableDeclarations:
      '($pipelineCloudRuleEntity: EntityManagementPipelineCloudRuleEntityCreateInput!)',
    body: 'entityManagementCreatePipelineCloudRule(pipelineCloudRuleEntity: $pipelineCloudRuleEntity) { entity { id type name description nrql enabled scope { id type } metadata { version } } }',
  }),
  pipelineRuleUpdate: mutation({
    name: 'PipelineRuleUpdate',
    sourceUrl: SOURCES.pipeline,
    variableDeclarations:
      '($id: ID!, $pipelineCloudRuleEntity: EntityManagementPipelineCloudRuleEntityUpdateInput!, $version: Int)',
    body: 'entityManagementUpdatePipelineCloudRule(id: $id, pipelineCloudRuleEntity: $pipelineCloudRuleEntity, version: $version) { entity { id type name description nrql enabled scope { id type } metadata { version } } }',
  }),

  accountCreate: mutation({
    name: 'AccountCreate',
    sourceUrl: SOURCES.accounts,
    variableDeclarations: '($managedAccount: AccountManagementCreateInput!)',
    body: 'accountManagementCreateAccount(managedAccount: $managedAccount) { managedAccount { id name regionCode } }',
  }),
  accountUpdate: mutation({
    name: 'AccountUpdate',
    sourceUrl: SOURCES.accounts,
    variableDeclarations: '($managedAccount: AccountManagementUpdateInput!)',
    body: 'accountManagementUpdateAccount(managedAccount: $managedAccount) { managedAccount { id name regionCode } }',
  }),
  accountCancel: mutation({
    name: 'AccountCancel',
    sourceUrl: SOURCES.accounts,
    variableDeclarations: '($id: Int!)',
    body: 'accountManagementCancelAccount(id: $id) { id isCanceled name regionCode }',
  }),
  userCreate: mutation({
    name: 'UserCreate',
    sourceUrl: SOURCES.admin,
    variableDeclarations:
      '($authenticationDomainId: ID!, $email: String!, $name: String!, $userType: UserManagementRequestedTierName!)',
    body: 'userManagementCreateUser(createUserOptions: { authenticationDomainId: $authenticationDomainId, email: $email, name: $name, userType: $userType }) { createdUser { authenticationDomainId email id name type { displayName id } } }',
  }),
  userUpdate: mutation({
    name: 'UserUpdate',
    sourceUrl: SOURCES.admin,
    variableDeclarations:
      '($id: ID!, $email: String, $name: String, $timeZone: String, $userType: UserManagementRequestedTierName)',
    body: 'userManagementUpdateUser(updateUserOptions: { id: $id, email: $email, name: $name, timeZone: $timeZone, userType: $userType }) { user { id email name timeZone type { displayName id } } }',
  }),
  userDelete: mutation({
    name: 'UserDelete',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($id: ID!)',
    body: 'userManagementDeleteUser(deleteUserOptions: { id: $id }) { deletedUser { id } }',
  }),
  groupCreate: mutation({
    name: 'GroupCreate',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($authenticationDomainId: ID!, $displayName: String!)',
    body: 'userManagementCreateGroup(createGroupOptions: { authenticationDomainId: $authenticationDomainId, displayName: $displayName }) { group { id displayName } }',
  }),
  groupUpdate: mutation({
    name: 'GroupUpdate',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($id: ID!, $displayName: String!)',
    body: 'userManagementUpdateGroup(updateGroupOptions: { id: $id, displayName: $displayName }) { group { id displayName } }',
  }),
  groupDelete: mutation({
    name: 'GroupDelete',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($id: ID!)',
    body: 'userManagementDeleteGroup(groupOptions: { id: $id }) { group { id } }',
  }),
  groupMembershipAdd: mutation({
    name: 'GroupMembershipAdd',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($groupIds: [ID!]!, $userIds: [ID!]!)',
    body: 'userManagementAddUsersToGroups(addUsersToGroupsOptions: { groupIds: $groupIds, userIds: $userIds }) { groups { id displayName } }',
  }),
  groupMembershipRemove: mutation({
    name: 'GroupMembershipRemove',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($groupIds: [ID!]!, $userIds: [ID!]!)',
    body: 'userManagementRemoveUsersFromGroups(removeUsersFromGroupsOptions: { groupIds: $groupIds, userIds: $userIds }) { groups { id displayName } }',
  }),
  customRoleCreate: mutation({
    name: 'CustomRoleCreate',
    sourceUrl: SOURCES.admin,
    variableDeclarations:
      '($organizationId: ID!, $name: String!, $permissionIds: [Int!]!, $scope: String!)',
    body: 'customRoleCreate(container: { id: $organizationId, type: "ORGANIZATION" }, name: $name, permissionIds: $permissionIds, scope: $scope) { id }',
  }),
  customRoleUpdate: mutation({
    name: 'CustomRoleUpdate',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($id: Int!, $name: String!, $permissionIds: [Int!]!)',
    body: 'customRoleUpdate(id: $id, name: $name, permissionIds: $permissionIds) { id }',
  }),
  customRoleDelete: mutation({
    name: 'CustomRoleDelete',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($id: Int!)',
    body: 'customRoleDelete(id: $id) { id }',
  }),
  accessGrantCreate: mutation({
    name: 'AccessGrantCreate',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($options: AuthorizationManagementGrantAccess!)',
    body: 'authorizationManagementGrantAccess(grantAccessOptions: $options) { accessGrants { id } roles { id name } }',
  }),
  accessGrantDelete: mutation({
    name: 'AccessGrantDelete',
    sourceUrl: SOURCES.admin,
    variableDeclarations: '($options: AuthorizationManagementRevokeAccess!)',
    body: 'authorizationManagementRevokeAccess(revokeAccessOptions: $options) { accessGrants { id } roles { id name } }',
  }),
  dataAccessPolicyCreate: mutation({
    name: 'DataAccessPolicyCreate',
    sourceUrl: SOURCES.dataAccess,
    variableDeclarations:
      '($organizationId: ID!, $name: String!, $policy: DataAccessPolicyRawDocument!)',
    body: 'dataAccessPolicyCreate(organizationId: $organizationId, name: $name, policy: $policy) { dataAccessPolicy { id name status policy } }',
  }),
  dataAccessPolicyUpdate: mutation({
    name: 'DataAccessPolicyUpdate',
    sourceUrl: SOURCES.dataAccess,
    variableDeclarations: '($id: ID!, $name: String, $policy: DataAccessPolicyRawDocument)',
    body: 'dataAccessPolicyUpdate(id: $id, name: $name, policy: $policy) { dataAccessPolicy { id name status policy } }',
  }),
  dataAccessPolicyDelete: mutation({
    name: 'DataAccessPolicyDelete',
    sourceUrl: SOURCES.dataAccess,
    variableDeclarations: '($id: ID!)',
    body: 'dataAccessPolicyDelete(id: $id) { dataAccessPolicy { id name status } }',
  }),
  apiIngestKeyUpdate: mutation({
    name: 'ApiIngestKeyUpdate',
    sourceUrl: SOURCES.apiKeys,
    variableDeclarations: '($keyId: ID!, $name: String, $notes: String)',
    body: 'apiAccessUpdateKeys(keys: { ingest: { keyId: $keyId, name: $name, notes: $notes } }) { updatedKeys { id type name notes } errors { message type } }',
  }),
  apiUserKeyUpdate: mutation({
    name: 'ApiUserKeyUpdate',
    sourceUrl: SOURCES.apiKeys,
    variableDeclarations: '($keyId: ID!, $name: String, $notes: String)',
    body: 'apiAccessUpdateKeys(keys: { user: { keyId: $keyId, name: $name, notes: $notes } }) { updatedKeys { id type name notes } errors { message type } }',
  }),
  apiIngestKeyDelete: mutation({
    name: 'ApiIngestKeyDelete',
    sourceUrl: SOURCES.apiKeys,
    variableDeclarations: '($keyIds: [ID!]!)',
    body: 'apiAccessDeleteKeys(keys: { ingestKeyIds: $keyIds }) { deletedKeys { id } errors { message type } }',
  }),
  apiUserKeyDelete: mutation({
    name: 'ApiUserKeyDelete',
    sourceUrl: SOURCES.apiKeys,
    variableDeclarations: '($keyIds: [ID!]!)',
    body: 'apiAccessDeleteKeys(keys: { userKeyIds: $keyIds }) { deletedKeys { id } errors { message type } }',
  }),
} as const;

export const NERDGRAPH_OPERATIONS: readonly NerdGraphOperation[] = Object.freeze([
  CONNECTION_CHECK,
  ACCOUNTS_LIST,
  ACCOUNT_ACCESS,
  NRQL_QUERY,
  NRQL_ASYNC_START,
  NRQL_ASYNC_STATUS,
  NRQL_ASYNC_CANCEL,
  ENTITY_SEARCH,
  ENTITY_GET,
  ENTITIES_GET,
  ENTITY_PAIR_GET,
  TARGET_AND_ENTITIES_GET,
  ACCOUNT_AND_ENTITIES_GET,
  ENTITY_AND_ACCOUNT_GET,
  ENTITY_RELATIONSHIPS,
  ENTITY_GOLDEN_DATA,
  TRACE_GET,
  ALERT_POLICIES_LIST,
  ALERT_POLICY_GET,
  ALERT_CONDITIONS_LIST,
  ALERT_CONDITION_GET,
  MUTING_RULES_LIST,
  NOTIFICATIONS_LIST,
  DASHBOARDS_LIST,
  DASHBOARD_GET,
  SYNTHETIC_MONITORS_LIST,
  SYNTHETIC_MONITOR_GET,
  SYNTHETIC_LOCATIONS_LIST,
  SYNTHETIC_DOWNTIMES_LIST,
  SYNTHETIC_SECURE_CREDENTIALS_LIST,
  WORKLOADS_LIST,
  WORKLOAD_GET,
  WORKLOAD_STATUS_GET,
  WORKLOAD_WRITE_PREREAD,
  SERVICE_LEVELS_LIST,
  SERVICE_LEVEL_GET,
  SERVICE_LEVEL_RESULTS,
  MAINTENANCE_WINDOWS_LIST,
  MAINTENANCE_WINDOW_AND_ENTITIES,
  LOG_CONFIGURATIONS_LIST,
  METRIC_NORMALIZATION_RULES_LIST,
  PIPELINE_RULES_LIST,
  ORGANIZATION_GET,
  ADMIN_RESOURCES_LIST,
  ADMIN_USERS_LIST,
  ADMIN_GROUPS_LIST,
  ADMIN_ROLES_LIST,
  ADMIN_GRANTS_LIST,
  ADMIN_DATA_ACCESS_POLICIES_LIST,
  ADMIN_USER_GET,
  ADMIN_TARGETS_GET,
  ADMIN_MEMBERSHIP_PREREAD,
  API_KEYS_LIST,
  ...Object.values(MUTATIONS),
]);

export function operationByName(name: string): NerdGraphOperation | undefined {
  return NERDGRAPH_OPERATIONS.find((operation) => operation.name === name);
}

export { SOURCES as OFFICIAL_OPERATION_SOURCES };
