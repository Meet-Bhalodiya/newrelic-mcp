import { describe, expect, it } from 'vitest';

import {
  API_KEYS_LIST,
  ACCOUNTS_LIST,
  ACCOUNT_ACCESS,
  ADMIN_ROLES_LIST,
  CONNECTION_CHECK,
  DASHBOARDS_LIST,
  DASHBOARD_GET,
  ENTITY_GET,
  ENTITY_PAIR_GET,
  ENTITY_RELATIONSHIPS,
  ENTITY_SEARCH,
  MAINTENANCE_WINDOWS_LIST,
  METRIC_NORMALIZATION_RULES_LIST,
  MUTATIONS,
  NERDGRAPH_OPERATIONS,
  NOTIFICATIONS_LIST,
  NRQL_QUERY,
  OFFICIAL_OPERATION_SOURCES,
  operationByName,
} from '../../src/operations/index.js';

describe('fixed NerdGraph operation catalog', () => {
  it('contains unique, named, non-introspection documents', () => {
    const names = NERDGRAPH_OPERATIONS.map(({ operationName }) => operationName);
    expect(new Set(names).size).toBe(names.length);
    for (const operation of NERDGRAPH_OPERATIONS) {
      expect(operation.name).toBe(operation.operationName);
      expect(operation.document.trim()).toMatch(
        operation.kind === 'query' ? /^query\b/u : /^mutation\b/u,
      );
      expect(operation.document).toContain(operation.operationName);
      expect(operation.document).not.toMatch(/__(?:schema|type)/u);
      expect(operation.sourceUrl).toMatch(/^https:\/\/docs\.newrelic\.com\//u);
      expect(operation.dataSchema).toBe(operation.responseSchema);
    }
  });

  it('looks operations up by canonical name', () => {
    expect(operationByName('ConnectionCheck')?.operationName).toBe('ConnectionCheck');
    expect(operationByName('not-real')).toBeUndefined();
  });

  it('validates identity leaves instead of accepting arbitrary GraphQL containers', () => {
    expect(
      CONNECTION_CHECK.responseSchema.safeParse({
        actor: { user: { id: 'user-1' }, accounts: [{ id: 1, name: 'Production' }] },
      }).success,
    ).toBe(true);
    expect(
      CONNECTION_CHECK.responseSchema.safeParse({
        actor: { user: { id: {} }, accounts: [{ id: '1', name: 123 }] },
      }).success,
    ).toBe(false);
    expect(
      ACCOUNTS_LIST.responseSchema.safeParse({ actor: { accounts: [{ id: '1', name: 123 }] } })
        .success,
    ).toBe(false);
    expect(
      ACCOUNT_ACCESS.responseSchema.safeParse({ actor: { account: { id: '1', name: 'Wrong' } } })
        .success,
    ).toBe(false);
  });

  it('does not query API key material', () => {
    expect(API_KEYS_LIST.document).not.toMatch(/\bkey\s*(?:\n|\})/u);
    expect(API_KEYS_LIST.document).not.toContain('truncatedKey');
    expect(API_KEYS_LIST.document).toContain('keySearch');
    expect(API_KEYS_LIST.document).toContain('scope: { accountIds: [$accountId] }');
  });

  it('uses the documented direct account-cancellation result', () => {
    expect(MUTATIONS.accountCancel.document).toContain(
      'accountManagementCancelAccount(id: $id) { id isCanceled name regionCode }',
    );
    expect(MUTATIONS.accountCancel.document).not.toContain('managedAccount');
  });

  it('contains no invented service-level delete operation', () => {
    expect(
      NERDGRAPH_OPERATIONS.some(({ operationName }) =>
        operationName.includes('ServiceLevelDelete'),
      ),
    ).toBe(false);
  });

  it('records an official source for every capability family', () => {
    expect(Object.keys(OFFICIAL_OPERATION_SOURCES).length).toBeGreaterThan(10);
    expect(
      Object.values(OFFICIAL_OPERATION_SOURCES).every((url) =>
        url.startsWith('https://docs.newrelic.com/'),
      ),
    ).toBe(true);
  });

  it('declares every referenced variable and rejects undeclared variables', () => {
    for (const operation of NERDGRAPH_OPERATIONS) {
      const declarationEnd = operation.document.indexOf('{');
      const declaration = operation.document.slice(0, declarationEnd);
      const body = operation.document.slice(declarationEnd);
      const declared = new Set(
        [...declaration.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/gu)].map((match) => match[1]),
      );
      const used = new Set(
        [...body.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/gu)].map((match) => match[1]),
      );
      expect(
        [...used].filter((name) => !declared.has(name)),
        operation.name,
      ).toEqual([]);

      const extra = operation.variablesSchema.safeParse({ __undeclared: true });
      expect(extra.success, operation.name).toBe(false);
      if (!extra.success) {
        expect(
          extra.error.issues.some((issue) => issue.code === 'unrecognized_keys'),
          operation.name,
        ).toBe(true);
      }
    }
  });

  it('requires the exact documented mutation response root and object value', () => {
    for (const operation of Object.values(MUTATIONS)) {
      const body = operation.document.slice(operation.document.indexOf('{') + 1);
      const root = /^\s*([_A-Za-z][_0-9A-Za-z]*)\s*\(/u.exec(body)?.[1];
      expect(root, operation.name).toBeDefined();
      expect(operation.responseSchema.safeParse({}).success, operation.name).toBe(false);
      expect(
        operation.responseSchema.safeParse({ [root ?? 'missing']: 42 }).success,
        operation.name,
      ).toBe(false);
      expect(
        operation.responseSchema.safeParse({ [root ?? 'missing']: [] }).success,
        operation.name,
      ).toBe(false);
      expect(
        operation.responseSchema.safeParse({ [root ?? 'missing']: {} }).success,
        operation.name,
      ).toBe(false);
    }
    expect(
      MUTATIONS.entityTagsAdd.responseSchema.safeParse({
        taggingAddTagsToEntity: { errors: [] },
      }).success,
    ).toBe(true);
    expect(
      MUTATIONS.alertPolicyCreate.responseSchema.safeParse({
        alertsPolicyCreate: {
          id: 'policy-1',
          name: 'Production',
          incidentPreference: 'PER_POLICY',
        },
      }).success,
    ).toBe(true);
    expect(
      MUTATIONS.alertPolicyCreate.responseSchema.safeParse({ alertsPolicyCreate: null }).success,
    ).toBe(false);
    expect(
      MUTATIONS.alertPolicyCreate.responseSchema.safeParse({
        alertsPolicyCreate: { id: {}, name: 42, incidentPreference: null },
      }).success,
    ).toBe(false);
    expect(
      MUTATIONS.entityTagsAdd.responseSchema.safeParse({ taggingAddTagsToEntity: {} }).success,
    ).toBe(false);
  });

  it('validates documented query containers instead of accepting path drift', () => {
    expect(CONNECTION_CHECK.responseSchema.safeParse({ actor: {} }).success).toBe(false);
    expect(
      CONNECTION_CHECK.responseSchema.safeParse({ actor: { user: 1, accounts: [] } }).success,
    ).toBe(false);
    expect(
      CONNECTION_CHECK.responseSchema.safeParse({ actor: { user: { id: 'u' }, accounts: [] } })
        .success,
    ).toBe(true);
  });

  it('type-validates deeply selected query fields while preserving nullable parents', () => {
    const nrqlData = {
      actor: {
        account: {
          id: 1,
          nrql: {
            results: [{ count: 1 }],
            metadata: {
              eventTypes: ['Transaction'],
              facets: ['appName'],
              timeWindow: { begin: 1, end: 2 },
            },
          },
        },
      },
    };
    expect(NRQL_QUERY.responseSchema.safeParse(nrqlData).success).toBe(true);
    expect(
      NRQL_QUERY.responseSchema.safeParse({
        ...nrqlData,
        actor: {
          account: {
            ...nrqlData.actor.account,
            nrql: {
              ...nrqlData.actor.account.nrql,
              metadata: {
                ...nrqlData.actor.account.nrql.metadata,
                timeWindow: { begin: 'not-a-timestamp', end: 2 },
              },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(NRQL_QUERY.responseSchema.safeParse({ actor: null }).success).toBe(true);
    expect(NRQL_QUERY.responseSchema.safeParse({ actor: { account: null } }).success).toBe(true);

    const relationships = {
      actor: {
        entity: {
          guid: 'source',
          accountId: 1,
          relatedEntities: {
            results: [
              {
                source: {
                  entity: {
                    guid: 'source',
                    name: 'Source',
                    domain: 'APM',
                    type: 'APPLICATION',
                    accountId: 1,
                  },
                },
                target: {
                  entity: {
                    guid: 'target',
                    name: 'Target',
                    domain: 'INFRA',
                    type: 'HOST',
                    accountId: 1,
                  },
                },
                type: 'CALLS',
              },
            ],
          },
        },
      },
    };
    expect(ENTITY_RELATIONSHIPS.responseSchema.safeParse(relationships).success).toBe(true);
    const malformedRelationships = structuredClone(relationships);
    malformedRelationships.actor.entity.relatedEntities.results[0]!.target.entity.accountId =
      'wrong' as never;
    expect(ENTITY_RELATIONSHIPS.responseSchema.safeParse(malformedRelationships).success).toBe(
      false,
    );

    const administration = {
      customerAdministration: {
        roles: {
          items: [{ id: 'role-1', name: 'Role', scope: 'organization', type: 'custom' }],
          nextCursor: null,
          totalCount: 1,
        },
        permissions: {
          items: [
            {
              category: 'APM',
              feature: 'entities',
              id: 'permission-1',
              name: 'View',
              product: 'New Relic',
            },
          ],
          nextCursor: null,
        },
      },
    };
    expect(ADMIN_ROLES_LIST.responseSchema.safeParse(administration).success).toBe(true);
    const malformedAdministration = structuredClone(administration);
    malformedAdministration.customerAdministration.permissions.items[0]!.feature = [] as never;
    expect(ADMIN_ROLES_LIST.responseSchema.safeParse(malformedAdministration).success).toBe(false);

    const maintenanceWindow = {
      actor: {
        maintenanceWindow: {
          listByIds: {
            maintenanceWindows: [
              {
                id: 'window-1',
                name: 'Maintenance',
                description: null,
                scope: { id: '1', type: 'ACCOUNT' },
                startTime: '2026-01-01T00:00:00',
                duration: 'PT2H',
                rrule: null,
                timezone: 'UTC',
                affectedEntityType: 'SERVICE_LEVEL',
                affectedEntities: ['entity-guid'],
                metadata: {
                  createdAt: '2026-01-01T00:00:00Z',
                  createdBy: { id: 'user-1' },
                  updatedAt: '2026-01-01T00:00:00Z',
                  updatedBy: { id: 'user-1' },
                },
              },
            ],
          },
        },
      },
    };
    expect(MAINTENANCE_WINDOWS_LIST.responseSchema.safeParse(maintenanceWindow).success).toBe(true);
    const malformedWindow = structuredClone(maintenanceWindow);
    malformedWindow.actor.maintenanceWindow.listByIds.maintenanceWindows[0]!.duration =
      7200 as never;
    expect(MAINTENANCE_WINDOWS_LIST.responseSchema.safeParse(malformedWindow).success).toBe(false);

    expect(
      ENTITY_SEARCH.responseSchema.safeParse({
        actor: {
          entitySearch: {
            results: {
              nextCursor: null,
              entities: [
                {
                  guid: 'entity-guid',
                  name: 'Entity',
                  domain: 'APM',
                  type: 'APPLICATION',
                  accountId: 1,
                  alertSeverity: 'NOT_ALERTING',
                  reporting: true,
                  tags: [{ key: 'environment', values: ['production'] }],
                },
              ],
            },
          },
        },
      }).success,
    ).toBe(true);

    expect(DASHBOARDS_LIST.document).toContain('entitySearch(query: $query)');
    expect(DASHBOARDS_LIST.document).not.toContain('scope:');

    expect(
      METRIC_NORMALIZATION_RULES_LIST.responseSchema.safeParse({
        actor: {
          account: {
            id: 1,
            metricNormalization: {
              metricNormalizationRules: [
                {
                  id: 1,
                  action: 'REPLACE',
                  applicationGuid: null,
                  applicationName: null,
                  createdAt: 1_743_641_443_000,
                  enabled: false,
                  evalOrder: 2_000,
                  matchExpression: '^metric$',
                  notes: null,
                  replacement: 'normalized',
                  terminateChain: true,
                },
              ],
            },
          },
        },
      }).success,
    ).toBe(true);

    expect(
      DASHBOARD_GET.responseSchema.safeParse({
        actor: {
          entity: {
            guid: 'dashboard-guid',
            name: 'Dashboard',
            accountId: 1,
            description: null,
            permissions: 'PRIVATE',
            pages: [],
            variables: [],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      DASHBOARD_GET.responseSchema.safeParse({ actor: { entity: { pages: [] } } }).success,
    ).toBe(false);
    expect(
      DASHBOARD_GET.responseSchema.safeParse({ actor: { entity: { pages: {} } } }).success,
    ).toBe(false);
    expect(
      ENTITY_GET.responseSchema.safeParse({ actor: { entity: { guid: 'missing-selections' } } })
        .success,
    ).toBe(false);
  });

  it('uses strict typed variables for nested monitor and pipeline inputs', () => {
    const scriptedApi = MUTATIONS.syntheticScriptApiCreate.variablesSchema;
    expect(
      scriptedApi.safeParse({
        accountId: 1,
        monitor: {
          name: 'API',
          period: 'EVERY_10_MINUTES',
          status: 'ENABLED',
          locations: { public: ['US_EAST_1'] },
          runtime: {
            runtimeType: 'NODE_API',
            runtimeTypeVersion: '16.10',
            scriptLanguage: 'JAVASCRIPT',
          },
          script: 'console.log(1)',
        },
      }).success,
    ).toBe(true);
    expect(
      scriptedApi.safeParse({
        accountId: 1,
        monitor: {
          name: 'API',
          period: 'EVERY_10_MINUTES',
          status: 'ENABLED',
          locations: { public: ['US_EAST_1'] },
          runtime: {
            runtimeType: 'NODE_API',
            runtimeTypeVersion: '16.10',
            scriptLanguage: 'JAVASCRIPT',
          },
          script: 'console.log(1)',
          uri: 'https://example.com',
        },
      }).success,
    ).toBe(false);
    expect(
      MUTATIONS.pipelineRuleCreate.variablesSchema.safeParse({
        pipelineCloudRuleEntity: {
          name: 'drop',
          description: 'drop test data',
          nrql: 'DELETE FROM TestEvent DROP',
          scope: { id: '1', type: 'ACCOUNT' },
        },
      }).success,
    ).toBe(false);
  });

  it('registers ownership helper operations and independent composite cursors', () => {
    expect(operationByName(ENTITY_PAIR_GET.name)).toBe(ENTITY_PAIR_GET);
    expect(NOTIFICATIONS_LIST.document).toContain('$destinationCursor');
    expect(NOTIFICATIONS_LIST.document).toContain('$channelCursor');
    expect(NOTIFICATIONS_LIST.document).toContain('$workflowCursor');
    expect(API_KEYS_LIST.document).toContain('$accountId');
  });
});
