import {
  Kind,
  OperationTypeNode,
  parse,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { z } from 'zod';

/**
 * NerdGraph does not publish a versioned, downloadable schema artifact. These
 * response type hints therefore cover the fields selected by our fixed query
 * documents. The GraphQL AST remains the source of truth for response shape;
 * this registry supplies only the scalar/list distinctions that cannot be
 * inferred from a selection set.
 */
const OBJECT_LIST_PATHS = new Set([
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

const BOOLEAN_FIELDS = new Set([
  'completed',
  'enabled',
  'reporting',
  'terminateChain',
  'workflowEnabled',
]);

const INTEGER_FIELDS = new Set([
  'column',
  'count',
  'entityCount',
  'evalOrder',
  'height',
  'locationsFailing',
  'locationsRunning',
  'row',
  'totalCount',
  'version',
  'violationTimeLimitSeconds',
  'width',
]);

const NUMBER_FIELDS = new Set([
  'anomalousValue',
  'averageMeasure',
  'begin',
  'durationMs',
  'end',
  'resultExpiration',
  'retryAfter',
  'retryDeadline',
  'successRate',
  'target',
  'timestamp',
]);

const NUMBER_PATHS = new Set([
  'actor.account.metricNormalization.metricNormalizationRules.createdAt',
]);

const STRING_LIST_PATHS = new Set([
  'actor.account.alerts.mutingRules.rules.condition.conditions.values',
  'actor.account.logConfigurations.obfuscationRules.actions.attributes',
  'actor.account.nrql.metadata.eventTypes',
  'actor.account.nrql.metadata.facets',
  'actor.entity.tags.values',
  'actor.entitySearch.results.entities.tags.values',
  'actor.maintenanceWindow.listByIds.maintenanceWindows.affectedEntities',
]);

const JSON_OBJECT_PATHS = new Set([
  'actor.distributedTracing.trace.spans.attributes',
  'actor.entity.pages.widgets.rawConfiguration',
]);

const JSON_PATHS = new Set(['customerAdministration.dataAccessPolicies.items.policy']);

const NRQL_RESULTS_PATHS = new Set([
  'actor.account.nrql.results',
  'actor.account.nrqlQueryProgress.results',
]);

const NUMERIC_ACCOUNT_ID_PATHS = new Set([
  'actor.account.id',
  'actor.accounts.id',
  'actor.entity.serviceLevel.indicators.events.account.id',
]);

function nullable<T>(schema: z.ZodType<T>): z.ZodType<T | null> {
  return z.union([schema, z.null()]);
}

function scalarSchema(field: string, path: string): z.ZodType<unknown> {
  if (NUMERIC_ACCOUNT_ID_PATHS.has(path) || field === 'accountId') {
    return nullable(z.number().int().positive());
  }
  if (NUMBER_PATHS.has(path)) return nullable(z.number());
  if (STRING_LIST_PATHS.has(path)) return nullable(z.array(z.string()));
  if (NRQL_RESULTS_PATHS.has(path)) {
    return nullable(z.array(z.record(z.string(), z.json())));
  }
  if (JSON_OBJECT_PATHS.has(path)) return nullable(z.record(z.string(), z.json()));
  if (JSON_PATHS.has(path)) return nullable(z.json());
  if (BOOLEAN_FIELDS.has(field)) return nullable(z.boolean());
  if (INTEGER_FIELDS.has(field)) return nullable(z.number().int());
  if (NUMBER_FIELDS.has(field)) return nullable(z.number());
  if (field === 'guid' || field.endsWith('Guid')) return nullable(z.string().min(1));
  if (field === 'id' || field.endsWith('Id')) {
    return nullable(z.union([z.string().min(1), z.number().int()]));
  }
  return nullable(z.string());
}

type SelectedField = {
  readonly schema: z.ZodType<unknown>;
  readonly conditional: boolean;
};

type CompiledSelection = {
  readonly fields: Map<string, SelectedField>;
  readonly baseFields: Set<string>;
  readonly conditionalGroups: readonly (readonly string[])[];
};

function fieldSchema(field: FieldNode, parentPath: string): z.ZodType<unknown> {
  const fieldName = field.name.value;
  const path = parentPath === '' ? fieldName : `${parentPath}.${fieldName}`;
  if (field.selectionSet === undefined) return scalarSchema(fieldName, path);

  const object = selectionSchema(field.selectionSet, path);
  if (OBJECT_LIST_PATHS.has(path)) {
    return nullable(z.array(nullable(object)));
  }
  return nullable(object);
}

function selectionFields(selectionSet: SelectionSetNode, parentPath: string): CompiledSelection {
  const fields = new Map<string, SelectedField>();
  const baseFields = new Set<string>();
  const conditionalGroups: string[][] = [];

  const responseNames = (set: SelectionSetNode): string[] => {
    const names: string[] = [];
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        names.push(selection.alias?.value ?? selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        names.push(...responseNames(selection.selectionSet));
      } else {
        throw new TypeError('Fixed NerdGraph queries must not contain named fragment spreads');
      }
    }
    return [...new Set(names)];
  };

  const addSelections = (set: SelectionSetNode, conditional: boolean): void => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const responseName = selection.alias?.value ?? selection.name.value;
        if (!conditional) baseFields.add(responseName);
        const existing = fields.get(responseName);
        if (existing !== undefined && !existing.conditional) continue;
        fields.set(responseName, {
          schema: fieldSchema(selection, parentPath),
          conditional,
        });
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        conditionalGroups.push(responseNames(selection.selectionSet));
        addSelections(selection.selectionSet, true);
        continue;
      }
      throw new TypeError('Fixed NerdGraph queries must not contain named fragment spreads');
    }
  };

  addSelections(selectionSet, false);
  return { fields, baseFields, conditionalGroups };
}

function selectionSchema(selectionSet: SelectionSetNode, parentPath: string): z.ZodType<unknown> {
  const selected = selectionFields(selectionSet, parentPath);
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [responseName, field] of selected.fields) {
    shape[responseName] = field.conditional ? field.schema.optional() : field.schema;
  }
  const schema = z.looseObject(shape);
  if (selected.conditionalGroups.length === 0) return schema;

  const occurrences = new Map<string, number>();
  for (const group of selected.conditionalGroups) {
    for (const field of group) occurrences.set(field, (occurrences.get(field) ?? 0) + 1);
  }
  return schema.superRefine((value, context) => {
    for (const group of selected.conditionalGroups) {
      const required = group.filter((field) => !selected.baseFields.has(field));
      const uniqueTriggers = required.filter((field) => occurrences.get(field) === 1);
      const triggers = uniqueTriggers.length > 0 ? uniqueTriggers : required;
      if (!triggers.some((field) => Object.hasOwn(value, field))) continue;
      for (const field of required) {
        if (!Object.hasOwn(value, field)) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'selected inline-fragment fields must be returned together',
          });
        }
      }
    }
  });
}

/** Compile a structural and scalar-typed validator from one fixed query. */
export function queryResponseSchema(document: string): z.ZodType<unknown> {
  const parsed = parse(document, { noLocation: true });
  const operations = parsed.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1 || operations[0]?.operation !== OperationTypeNode.QUERY) {
    throw new TypeError('A fixed query response schema requires exactly one query operation');
  }
  if (parsed.definitions.length !== 1) {
    throw new TypeError('Fixed NerdGraph queries must not contain fragment definitions');
  }
  return selectionSchema(operations[0].selectionSet, '');
}
