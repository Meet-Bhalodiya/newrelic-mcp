import { describe, expect, it, vi } from 'vitest';

import type { NerdGraphExecutionResult, NerdGraphOperation } from '../../src/operations/index.js';
import {
  ALL_TOOL_NAMES,
  EXCLUDED_CAPABILITIES,
  TOOL_CATALOG,
  assertReadOnlyNrql,
  assertAccountAllowlist,
  buildToolDefinitions,
  confirmationPhrase,
  enabledToolNames,
  filterResponseToAccountAllowlist,
  type ToolExecutionContext,
} from '../../src/toolsets/index.js';

function context(
  execute: (
    operation: NerdGraphOperation,
    variables: Record<string, unknown>,
  ) => Promise<NerdGraphExecutionResult>,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    executor: { execute },
    gates: {},
    region: 'US',
    requestId: 'test-request',
    now: () => 100,
    ...overrides,
  };
}

describe('tool capability catalog', () => {
  it('is unique and includes every required read surface', () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
    expect(ALL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'connection_check',
        'nrql_query',
        'logs_query',
        'trace_get',
        'entities_search',
        'alert_policies_list',
        'dashboards_list',
        'synthetic_monitors_list',
        'workloads_list',
        'service_levels_list',
        'log_configurations_list',
        'metric_normalization_rules_list',
        'organization_get',
      ]),
    );
    expect(
      TOOL_CATALOG.every(({ operation }) =>
        operation.sourceUrl.startsWith('https://docs.newrelic.com/'),
      ),
    ).toBe(true);
  });

  it('explicitly omits secret-bearing and unsupported capabilities', () => {
    expect(ALL_TOOL_NAMES).not.toContain('api_key_create');
    expect(ALL_TOOL_NAMES).not.toContain('service_level_delete');
    expect(ALL_TOOL_NAMES).not.toContain('entity_delete');
    expect(EXCLUDED_CAPABILITIES).toHaveProperty('synthetic_secure_credential_mutation');
    expect(EXCLUDED_CAPABILITIES).toHaveProperty('slack_destination_create');
  });

  it('uses collection-specific administration reads for least-data access', () => {
    expect(
      Object.fromEntries(
        TOOL_CATALOG.filter(({ name }) =>
          [
            'groups_list',
            'custom_roles_list',
            'access_grants_list',
            'data_access_policies_list',
          ].includes(name),
        ).map(({ name, operation }) => [name, operation.operationName]),
      ),
    ).toEqual({
      groups_list: 'AdminGroupsList',
      custom_roles_list: 'AdminRolesList',
      access_grants_list: 'AdminGrantsList',
      data_access_policies_list: 'AdminDataAccessPoliciesList',
    });
  });

  it('rejects credentials hidden inside notification property URLs', () => {
    const schema = TOOL_CATALOG.find(({ name }) => name === 'notification_create')?.inputSchema;
    const result = schema?.safeParse({
      accountId: 1,
      kind: 'destination',
      value: {
        name: 'webhook',
        type: 'WEBHOOK',
        properties: [
          {
            key: 'url',
            value: 'https://user:password@example.com/hook?token=top-secret',
          },
        ],
      },
    });

    expect(result?.success).toBe(false);
  });

  it('registers only read/non-admin tools by default', () => {
    const enabled = enabledToolNames({});
    expect(enabled).toContain('nrql_query');
    expect(enabled).not.toContain('dashboard_create');
    expect(enabled).not.toContain('nrql_async_cancel');
    expect(enabled).not.toContain('organization_get');
  });

  it('marks conditionally destructive tools conservatively for MCP clients', () => {
    const dashboardCreate = buildToolDefinitions(
      context(async () => ({ data: {} }), { gates: { writes: true } }),
    ).find(({ name }) => name === 'dashboard_create');

    expect(dashboardCreate?.annotations.destructiveHint).toBe(true);
    expect(dashboardCreate?.description).toContain('destructive gate');
  });

  it('requires every independent gate', () => {
    expect(enabledToolNames({ writes: true })).toContain('dashboard_create');
    expect(enabledToolNames({ writes: true })).not.toContain('dashboard_delete');
    expect(enabledToolNames({ writes: true, destructive: true })).toContain('dashboard_delete');
    expect(enabledToolNames({ admin: true })).toContain('organization_get');
    expect(enabledToolNames({ writes: true, admin: true })).toContain('user_create');
    expect(enabledToolNames({ writes: true, admin: true })).not.toContain('user_delete');
    expect(enabledToolNames({ writes: true, admin: true, destructive: true })).toContain(
      'user_delete',
    );
    expect(enabledToolNames({ writes: true, destructive: true })).not.toContain(
      'metric_normalization_rule_create',
    );
    expect(enabledToolNames({ writes: true, destructive: true, previewApis: true })).toContain(
      'metric_normalization_rule_create',
    );
    expect(enabledToolNames({ writes: true })).not.toContain('issue_acknowledge');
    expect(enabledToolNames({ writes: true, experimentalAiIssues: true })).toContain(
      'issue_acknowledge',
    );
  });

  it('honors enabled toolsets', () => {
    const enabled = enabledToolNames({ enabledToolsets: ['core'] });
    expect(enabled).toEqual(['connection_check', 'accounts_list']);
  });

  it('omits no-op page sizes and exposes real cursors', () => {
    const entities = TOOL_CATALOG.find(({ name }) => name === 'entities_search');
    const synthetics = TOOL_CATALOG.find(({ name }) => name === 'synthetic_monitors_list');
    const notifications = TOOL_CATALOG.find(({ name }) => name === 'notifications_list');
    expect(
      entities?.inputSchema.safeParse({ query: "type = 'SERVICE'", pageSize: 10 }).success,
    ).toBe(false);
    expect(synthetics?.inputSchema.safeParse({ accountId: 1, cursor: 'next' }).success).toBe(true);
    expect(
      notifications?.inputSchema.safeParse({
        accountId: 1,
        destinationCursor: 'd',
        channelCursor: 'c',
        workflowCursor: 'w',
      }).success,
    ).toBe(true);
  });

  it('validates every nested NRQL surface and isolates Pipeline DELETE', () => {
    const alertCreate = TOOL_CATALOG.find(({ name }) => name === 'alert_condition_create');
    const dashboardCreate = TOOL_CATALOG.find(({ name }) => name === 'dashboard_create');
    const logCreate = TOOL_CATALOG.find(({ name }) => name === 'log_configuration_create');
    const pipelineCreate = TOOL_CATALOG.find(({ name }) => name === 'pipeline_rule_create');

    expect(
      alertCreate?.inputSchema.safeParse({
        accountId: 1,
        policyId: 'p',
        condition: {
          name: 'unsafe',
          enabled: true,
          nrql: { query: 'DELETE FROM Transaction' },
          terms: [
            {
              operator: 'ABOVE',
              priority: 'CRITICAL',
              threshold: 1,
              thresholdDuration: 60,
              thresholdOccurrences: 'ALL',
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      dashboardCreate?.inputSchema.safeParse({
        accountId: 1,
        dashboard: {
          name: 'unsafe',
          permissions: 'PRIVATE',
          pages: [
            {
              name: 'page',
              widgets: [
                { rawConfiguration: { nrqlQueries: [{ query: 'DELETE FROM Transaction' }] } },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      logCreate?.inputSchema.safeParse({
        accountId: 1,
        configuration: {
          type: 'parsing_rule',
          description: 'unsafe',
          enabled: true,
          grok: '%{GREEDYDATA:message}',
          lucene: 'service:test',
          nrql: 'DELETE FROM Log',
        },
      }).success,
    ).toBe(false);
    expect(
      pipelineCreate?.inputSchema.safeParse({
        accountId: 1,
        rule: { name: 'drop', description: 'drop data', nrql: 'DELETE FROM TestEvent' },
      }).success,
    ).toBe(true);
    expect(
      pipelineCreate?.inputSchema.safeParse({
        accountId: 1,
        rule: { name: 'drop', description: 'drop data', nrql: 'DELETE FROM TestEvent DROP' },
      }).success,
    ).toBe(false);
  });

  it('enforces strict synthetic monitor branches', () => {
    const syntheticCreate = TOOL_CATALOG.find(({ name }) => name === 'synthetic_monitor_create');
    const base = {
      accountId: 1,
      monitorType: 'scripted-api',
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
    };
    expect(syntheticCreate?.inputSchema.safeParse(base).success).toBe(true);
    expect(
      syntheticCreate?.inputSchema.safeParse({
        ...base,
        monitor: { ...base.monitor, uri: 'https://example.com' },
      }).success,
    ).toBe(false);
    expect(
      syntheticCreate?.inputSchema.safeParse({
        ...base,
        monitor: { ...base.monitor, status: 'MUTED' },
      }).success,
    ).toBe(false);
  });
});

describe('NRQL safety', () => {
  it('adds a default limit and preserves smaller limits', () => {
    expect(assertReadOnlyNrql('SELECT count(*) FROM Transaction')).toBe(
      'SELECT count(*) FROM Transaction\nLIMIT 100',
    );
    expect(assertReadOnlyNrql('FROM Log SELECT * LIMIT 50', ['Log'])).toContain('LIMIT 50');
  });

  it.each([
    'DELETE FROM Metric',
    'SELECT * FROM Log; DELETE FROM Log',
    'SELECT * FROM Log LIMIT MAX',
    'SELECT * FROM Log LIMIT 5001',
  ])('rejects unsafe NRQL: %s', (query) => {
    expect(() => assertReadOnlyNrql(query)).toThrow();
  });

  it('does not treat mutation words inside literals as operations', () => {
    expect(assertReadOnlyNrql("SELECT * FROM Log WHERE message = 'DELETE FROM Log'")).toContain(
      'LIMIT 100',
    );
  });

  it('enforces telemetry event types', () => {
    expect(() => assertReadOnlyNrql('SELECT * FROM Span', ['Log'])).toThrow(/only permits/u);
    expect(() => assertReadOnlyNrql('FROM Span SELECT count(*) AS Log', ['Log'])).toThrow(
      /only permits/u,
    );
    expect(() => assertReadOnlyNrql('FROM Log, Span SELECT count(*)', ['Log'])).toThrow(
      /only permits/u,
    );
  });
});

describe('safe handlers', () => {
  it('creates a stable, argument-bound confirmation phrase', () => {
    const left = confirmationPhrase('tool', { b: 2, a: 1, dryRun: true });
    const right = confirmationPhrase('tool', {
      a: 1,
      b: 2,
      dryRun: false,
      confirmation: 'ignored',
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^APPLY tool [a-f0-9]{16}$/u);
  });

  it('uses the five-query semaphore only for dynamically complex NRQL', async () => {
    const seen: NerdGraphOperation[] = [];
    const tools = buildToolDefinitions(
      context(async (operation) => {
        seen.push(operation);
        return operation.operationName === 'NrqlAsyncStatus'
          ? {
              data: {
                actor: {
                  account: {
                    id: 1,
                    nrqlQueryProgress: { queryProgress: { queryId: 'query-1' }, results: [] },
                  },
                },
              },
            }
          : { data: { actor: { account: { id: 1, nrql: { results: [] } } } } };
      }),
    );
    const query = tools.find(({ name }) => name === 'nrql_query');
    const status = tools.find(({ name }) => name === 'nrql_async_status');

    await query?.handler({ accountId: 1, query: 'FROM Transaction SELECT count(*)' });
    await query?.handler({
      accountId: 1,
      query: 'FROM Transaction SELECT count(*) FACET appName',
    });
    await status?.handler({ accountId: 1, queryId: 'query-1' });

    expect(seen.map(({ complexNrql }) => complexNrql)).toEqual([false, true, undefined]);
  });

  it('rejects nested and suffixed account references outside the allowlist', () => {
    const scoped = context(async () => ({ data: {} }), { accountAllowlist: [42] });
    expect(() => assertAccountAllowlist({ targetAccountId: 999 }, scoped)).toThrow(
      /outside the configured allowlist/u,
    );
    expect(() =>
      assertAccountAllowlist(
        { maintenanceWindow: { scope: { type: 'ACCOUNT', id: '999' } } },
        scoped,
      ),
    ).toThrow(/outside the configured allowlist/u);
    expect(() => assertAccountAllowlist({ managedAccount: { id: 42 } }, scoped)).not.toThrow();
  });

  it('pre-reads, dry-runs, applies only exact confirmation, and reads back', async () => {
    let mutationApplied = false;
    const execute = vi.fn(async (operation: NerdGraphOperation) => {
      if (operation.kind === 'mutation') {
        mutationApplied = true;
        return { data: { taggingAddTagsToEntity: { errors: [] } } };
      }
      return {
        data: {
          actor: {
            entity: {
              guid: 'entity',
              accountId: 1,
              tags: mutationApplied ? [{ key: 'team', values: ['platform'] }] : [],
            },
          },
        },
      };
    });
    const definitions = buildToolDefinitions(
      context(execute, {
        gates: { writes: true },
        accountAllowlist: [1],
      }),
    );
    const tool = definitions.find(({ name }) => name === 'entity_tags_add');
    expect(tool).toBeDefined();
    const arguments_ = { guid: 'entity', tags: [{ key: 'team', values: ['platform'] }] };
    const preview = await tool?.handler(arguments_);
    const previewData = preview?.structuredContent.data as {
      confirmationPhrase: string;
      dryRun: boolean;
    };
    expect(previewData.dryRun).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(
      tool?.handler({ ...arguments_, dryRun: false, confirmation: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'confirmation_required',
    });
    const applied = await tool?.handler({
      ...arguments_,
      dryRun: false,
      confirmation: previewData.confirmationPhrase,
    });
    expect(applied?.structuredContent.ok).toBe(true);
    expect(applied?.structuredContent.meta.partial).toBe(false);
    expect(applied?.structuredContent.data).toMatchObject({
      verification: { verified: true },
    });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it.each(['partial', 'truncated'] as const)(
    'fails closed when a write pre-read is %s',
    async (incompleteFlag) => {
      const execute = vi.fn(async () => ({
        data: { actor: { entity: { guid: 'entity', accountId: 1, tags: [] } } },
        [incompleteFlag]: true,
      }));
      const tool = buildToolDefinitions(
        context(execute, { gates: { writes: true }, accountAllowlist: [1] }),
      ).find(({ name }) => name === 'entity_tags_add');

      await expect(
        tool?.handler({ guid: 'entity', tags: [{ key: 'team', values: ['platform'] }] }),
      ).rejects.toMatchObject({ code: 'upstream_schema' });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('walks muting-rule pre-read cursors before returning not_found', async () => {
    const execute = vi.fn(
      async (
        _operation: NerdGraphOperation,
        variables: Record<string, unknown>,
        _options?: { readonly bypassCache?: boolean },
      ) => ({
        data: {
          actor: {
            account: {
              id: 1,
              alerts: {
                mutingRules: {
                  nextCursor: variables.cursor === 'muting-page-2' ? null : 'muting-page-2',
                  rules:
                    variables.cursor === 'muting-page-2'
                      ? [{ id: 'target-rule', name: 'Target' }]
                      : [{ id: 'first-rule', name: 'First' }],
                },
              },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'muting_rule_update');

    const preview = await tool?.handler({
      accountId: 1,
      id: 'target-rule',
      rule: {
        name: 'Target',
        enabled: true,
        condition: {
          operator: 'AND',
          conditions: [{ attribute: 'targetName', operator: 'EQUALS', values: ['service'] }],
        },
      },
    });

    expect(preview?.structuredContent.ok).toBe(true);
    expect(preview?.structuredContent.data).toMatchObject({
      before: {
        accountId: 1,
        target: { id: 'target-rule', name: 'Target' },
      },
    });
    expect(JSON.stringify(preview?.structuredContent.data)).not.toContain('first-rule');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toEqual({ accountId: 1, cursor: 'muting-page-2' });
    expect(execute.mock.calls.every((call) => call[2]?.bypassCache === true)).toBe(true);
  });

  it('projects a late paginated target so dry-run retains its confirmation within budget', async () => {
    const priorRules = Array.from({ length: 60 }, (_, index) => ({
      id: `prior-${String(index)}`,
      name: `Prior ${String(index)}`,
      description: 'x'.repeat(10_000),
    }));
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          actor: {
            account: {
              id: 1,
              alerts: {
                mutingRules: {
                  nextCursor: variables.cursor === 'target-page' ? null : 'target-page',
                  rules:
                    variables.cursor === 'target-page'
                      ? [{ id: 'target-rule', name: 'Target', enabled: true }]
                      : priorRules,
                },
              },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'muting_rule_update');

    const preview = await tool?.handler({
      accountId: 1,
      id: 'target-rule',
      rule: {
        name: 'Target',
        enabled: true,
        condition: {
          operator: 'AND',
          conditions: [{ attribute: 'targetName', operator: 'EQUALS', values: ['service'] }],
        },
      },
    });

    const serialized = JSON.stringify(preview);
    expect(serialized.length).toBeLessThan(64 * 1024);
    expect(serialized).toContain('confirmationPhrase');
    expect(serialized).toContain('target-rule');
    expect(serialized).not.toContain('prior-0');
  });

  it('binds a paginated confirmation to the projected target state', async () => {
    let revision = 1;
    let unrelatedRevision = 1;
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          actor: {
            account: {
              id: 1,
              alerts: {
                mutingRules: {
                  nextCursor: variables.cursor === 'target-page' ? null : 'target-page',
                  rules:
                    variables.cursor === 'target-page'
                      ? [{ id: 'target-rule', name: 'Target', revision }]
                      : [{ id: 'unrelated', name: 'Unrelated', revision: unrelatedRevision }],
                },
              },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'muting_rule_delete');
    const arguments_ = { accountId: 1, id: 'target-rule' };
    const first = await tool?.handler(arguments_);
    const firstPhrase = (first?.structuredContent.data as { confirmationPhrase: string })
      .confirmationPhrase;

    unrelatedRevision = 2;
    const unrelatedChanged = await tool?.handler(arguments_);
    expect(
      (unrelatedChanged?.structuredContent.data as { confirmationPhrase: string })
        .confirmationPhrase,
    ).toBe(firstPhrase);

    revision = 2;
    await expect(
      tool?.handler({ ...arguments_, dryRun: false, confirmation: firstPhrase }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(execute).toHaveBeenCalledTimes(6);
    expect(execute.mock.calls.every(([operation]) => operation.kind === 'query')).toBe(true);
  });

  it('validates every paginated page ownership envelope before merging connections', async () => {
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          actor: {
            account: {
              id: variables.cursor === 'foreign-page' ? 2 : 1,
              alerts: {
                mutingRules: {
                  nextCursor: variables.cursor === 'foreign-page' ? null : 'foreign-page',
                  rules:
                    variables.cursor === 'foreign-page'
                      ? [{ id: 'target-rule', name: 'Foreign target' }]
                      : [],
                },
              },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'muting_rule_delete');

    await expect(tool?.handler({ accountId: 1, id: 'target-rule' })).rejects.toMatchObject({
      code: 'authorization',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['partial', 'truncated'] as const)(
    'fails closed when a later paginated pre-read page is %s',
    async (incompleteFlag) => {
      const execute = vi.fn(
        async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
          data: {
            actor: {
              account: {
                id: 1,
                alerts: {
                  mutingRules: {
                    nextCursor: variables.cursor === 'incomplete-page' ? null : 'incomplete-page',
                    rules:
                      variables.cursor === 'incomplete-page'
                        ? [{ id: 'target-rule', name: 'Target' }]
                        : [],
                  },
                },
              },
            },
          },
          ...(variables.cursor === 'incomplete-page' ? { [incompleteFlag]: true } : {}),
        }),
      );
      const tool = buildToolDefinitions(
        context(execute, {
          gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
          accountAllowlist: [1],
        }),
      ).find(({ name }) => name === 'muting_rule_delete');

      await expect(tool?.handler({ accountId: 1, id: 'target-rule' })).rejects.toMatchObject({
        code: 'upstream_schema',
      });
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it('merges only the required notification pages and projects every workflow prerequisite', async () => {
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          actor: {
            account: {
              id: 1,
              aiNotifications: {
                destinations: { nextCursor: null, entities: [] },
                channels: {
                  nextCursor:
                    variables.channelCursor === 'channels-page-2' ? null : 'channels-page-2',
                  entities:
                    variables.channelCursor === 'channels-page-2'
                      ? [{ id: 'channel-2', name: 'Second' }]
                      : [
                          { id: 'channel-1', name: 'First' },
                          { id: 'unrelated', name: 'Ignore' },
                        ],
                },
              },
              aiWorkflows: { workflows: { nextCursor: null, entities: [] } },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'notification_create');

    const preview = await tool?.handler({
      accountId: 1,
      kind: 'workflow',
      value: {
        destinationConfigurations: [
          { channelId: 'channel-1', notificationTriggers: ['ACTIVATED'] },
          { channelId: 'channel-2', notificationTriggers: ['CLOSED'] },
        ],
        destinationsEnabled: true,
        enrichmentsEnabled: false,
        issuesFilter: { type: 'FILTER', predicates: [] },
        mutingRulesHandling: 'NOTIFY_ALL_ISSUES',
        name: 'Workflow',
        workflowEnabled: true,
      },
    });

    expect(preview?.structuredContent.data).toMatchObject({
      before: {
        accountId: 1,
        prerequisites: [{ id: 'channel-1' }, { id: 'channel-2' }],
      },
    });
    expect(JSON.stringify(preview?.structuredContent.data)).not.toContain('unrelated');
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ channelCursor: 'channels-page-2' });
  });

  it('walks the relevant notification cursor before authorizing a test mutation', async () => {
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          actor: {
            account: {
              id: 1,
              aiNotifications: {
                destinations: { nextCursor: null, entities: [] },
                channels: {
                  nextCursor:
                    variables.channelCursor === 'channel-page-2' ? null : 'channel-page-2',
                  entities:
                    variables.channelCursor === 'channel-page-2'
                      ? [{ id: 'target-channel', name: 'Target' }]
                      : [{ id: 'first-channel', name: 'First' }],
                },
              },
              aiWorkflows: { workflows: { nextCursor: null, entities: [] } },
            },
          },
        },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, enabledToolsets: ['alerts'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'notification_test');

    const preview = await tool?.handler({ accountId: 1, channelId: 'target-channel' });

    expect(preview?.structuredContent.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toMatchObject({
      accountId: 1,
      channelCursor: 'channel-page-2',
    });
  });

  it('walks data-access-policy pages and fails closed on a repeated cursor', async () => {
    const paginatedExecute = vi.fn(
      async (_operation: NerdGraphOperation, variables: Record<string, unknown>) => ({
        data: {
          customerAdministration: {
            dataAccessPolicies: {
              nextCursor: variables.cursor === 'policy-page-2' ? null : 'policy-page-2',
              items:
                variables.cursor === 'policy-page-2'
                  ? [{ id: 'target-policy', name: 'Target' }]
                  : [{ id: 'first-policy', name: 'First' }],
            },
          },
        },
      }),
    );
    const paginatedTool = buildToolDefinitions(
      context(paginatedExecute, {
        gates: {
          writes: true,
          destructive: true,
          admin: true,
          enabledToolsets: ['admin'],
        },
      }),
    ).find(({ name }) => name === 'data_access_policy_delete');

    const preview = await paginatedTool?.handler({
      organizationId: 'organization',
      id: 'target-policy',
    });
    expect(preview?.structuredContent.ok).toBe(true);
    expect(paginatedExecute.mock.calls.map((call) => call[0].operationName)).toEqual([
      'AdminDataAccessPoliciesList',
      'AdminDataAccessPoliciesList',
    ]);

    const repeatedCursorTool = buildToolDefinitions(
      context(
        async () => ({
          data: {
            actor: {
              account: {
                id: 1,
                alerts: {
                  mutingRules: {
                    nextCursor: 'same-cursor',
                    rules: [],
                  },
                },
              },
            },
          },
        }),
        {
          gates: { writes: true, destructive: true, enabledToolsets: ['alerts'] },
          accountAllowlist: [1],
        },
      ),
    ).find(({ name }) => name === 'muting_rule_delete');
    await expect(
      repeatedCursorTool?.handler({ accountId: 1, id: 'missing-rule' }),
    ).rejects.toMatchObject({ code: 'upstream_schema' });
  });

  it('invalidates a confirmation when the pre-read state changes', async () => {
    let revision = 1;
    const execute = vi.fn(
      async (
        operation: NerdGraphOperation,
        _variables: Record<string, unknown>,
        _options?: {
          readonly signal?: AbortSignal;
          readonly bypassCache?: boolean;
          readonly requestId?: string;
        },
      ) => ({
        data:
          operation.kind === 'query'
            ? { actor: { entity: { guid: 'entity', accountId: 1, revision, tags: [] } } }
            : { taggingAddTagsToEntity: { errors: [] } },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, { gates: { writes: true }, accountAllowlist: [1] }),
    ).find(({ name }) => name === 'entity_tags_add');
    const arguments_ = { guid: 'entity', tags: [{ key: 'team', values: ['platform'] }] };
    const preview = await tool?.handler(arguments_);
    const confirmation = (preview?.structuredContent.data as { confirmationPhrase: string })
      .confirmationPhrase;

    revision = 2;
    await expect(
      tool?.handler({ ...arguments_, dryRun: false, confirmation }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([operation]) => operation.kind === 'query')).toBe(true);
    expect(execute.mock.calls.every((call) => call[2]?.bypassCache === true)).toBe(true);
    expect(execute.mock.calls.every((call) => call[2]?.requestId === 'test-request')).toBe(true);
  });

  it('filters account lists and mixed entity arrays', () => {
    const filtered = filterResponseToAccountAllowlist(
      {
        actor: {
          accounts: [
            { id: 1, name: 'allowed' },
            { id: 2, name: 'hidden' },
          ],
          entities: [
            { guid: 'a', accountId: 1 },
            { guid: 'b', accountId: 2 },
          ],
        },
      },
      context(async () => ({ data: {} }), { accountAllowlist: [1] }),
    );
    expect(filtered).toEqual({
      actor: { accounts: [{ id: 1, name: 'allowed' }], entities: [{ guid: 'a', accountId: 1 }] },
    });
  });

  it('rejects direct entity data outside the allowlist', () => {
    expect(() =>
      filterResponseToAccountAllowlist(
        { actor: { entity: { guid: 'hidden', accountId: 2 } } },
        context(async () => ({ data: {} }), { accountAllowlist: [1] }),
      ),
    ).toThrow(/outside the configured allowlist/u);
  });

  it('fails closed when entity or trace ownership is missing from partial data', () => {
    const scoped = context(async () => ({ data: {} }), { accountAllowlist: [1] });
    expect(() =>
      filterResponseToAccountAllowlist(
        { actor: { entity: { guid: 'unknown-owner', name: 'Service' } } },
        scoped,
      ),
    ).toThrow(/ownership field/u);
    expect(() =>
      filterResponseToAccountAllowlist(
        {
          actor: {
            distributedTracing: {
              trace: {
                entities: null,
                spans: [{ id: 'span', entityGuid: 'unknown-owner' }],
              },
            },
          },
        },
        scoped,
      ),
    ).toThrow(/Trace ownership/u);
    expect(() =>
      filterResponseToAccountAllowlist(
        {
          actor: {
            distributedTracing: {
              trace: {
                entities: [{ guid: 'known', accountId: 1 }],
                spans: [{ id: 'span', entityGuid: 'missing' }],
              },
            },
          },
        },
        scoped,
      ),
    ).toThrow(/ownership was unavailable/u);
    expect(() =>
      filterResponseToAccountAllowlist(
        {
          actor: {
            distributedTracing: {
              trace: {
                entities: [{ guid: 'known', accountId: 1 }],
                spans: [{ id: 'unattributed-span' }],
              },
            },
          },
        },
        scoped,
      ),
    ).toThrow(/ownership was unavailable/u);
    expect(() =>
      filterResponseToAccountAllowlist({ actor: { account: { name: 'unknown' } } }, scoped),
    ).toThrow(/account data omitted/u);
    expect(() =>
      filterResponseToAccountAllowlist({ actor: { accounts: [{ name: 'unknown' }] } }, scoped),
    ).toThrow(/account data omitted/u);
    expect(() =>
      filterResponseToAccountAllowlist(
        {
          actor: {
            entitySearch: { results: { entities: [{ name: 'unknown', type: 'DASHBOARD' }] } },
          },
        },
        scoped,
      ),
    ).toThrow(/entity data omitted/u);
  });

  it('scopes entity search queries to the entire account allowlist', async () => {
    const execute = vi.fn(
      async (_operation: NerdGraphOperation, _variables: Record<string, unknown>) => ({
        data: { actor: { entitySearch: { results: { entities: [] } } } },
      }),
    );
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { enabledToolsets: ['entities'] },
        accountAllowlist: [7, 3],
      }),
    ).find(({ name }) => name === 'entities_search');
    await tool?.handler({ query: "type = 'SERVICE'" });
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      query: "(type = 'SERVICE') AND accountId IN (3,7)",
    });
  });

  it('returns not_found for a missing get target', async () => {
    const tool = buildToolDefinitions(
      context(async () => ({ data: { actor: { entity: null } } }), {
        gates: { enabledToolsets: ['entities'] },
      }),
    ).find(({ name }) => name === 'entities_get');
    await expect(tool?.handler({ guid: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('requires ownership pre-reads for both relationship endpoints', async () => {
    const execute = vi.fn(async (_operation: NerdGraphOperation) => ({
      data: {
        actor: {
          source: { guid: 'source', accountId: 1 },
          target: null,
        },
      },
    }));
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, enabledToolsets: ['entities'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'entity_relationship_put');
    await expect(
      tool?.handler({ sourceGuid: 'source', targetGuid: 'missing', type: 'CALLS' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(execute.mock.calls[0]?.[0].operationName).toBe('EntityPairGet');
  });

  it('does not authorize API-key writes by ID outside the requested account', async () => {
    const execute = vi.fn(async () => ({
      data: {
        actor: {
          account: { id: 1, name: 'one' },
          apiAccess: {
            keySearch: { keys: [{ id: 'key', type: 'USER', accountId: 2, name: 'other' }] },
          },
        },
      },
    }));
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true, destructive: true, admin: true, enabledToolsets: ['admin'] },
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'api_key_delete');
    await expect(
      tool?.handler({ accountId: 1, keyType: 'USER', keyIds: ['key'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('redacts scripts in mutation previews', async () => {
    const execute = vi.fn(async () => ({
      data: { actor: { account: { id: 1, name: 'account' } } },
    }));
    const tool = buildToolDefinitions(
      context(execute, {
        gates: { writes: true },
        defaultAccountId: 1,
        accountAllowlist: [1],
      }),
    ).find(({ name }) => name === 'synthetic_monitor_create');
    const result = await tool?.handler({
      monitorType: 'scripted-api',
      monitor: {
        name: 'check',
        period: 'EVERY_10_MINUTES',
        status: 'ENABLED',
        locations: { public: ['US_EAST_1'] },
        runtime: {
          runtimeType: 'NODE_API',
          runtimeTypeVersion: '16.10',
          scriptLanguage: 'JAVASCRIPT',
        },
        script: "console.log('secret')",
      },
    });
    expect(JSON.stringify(result?.structuredContent)).not.toContain('console.log');
    expect(JSON.stringify(result?.structuredContent)).toContain('[REDACTED]');
  });
});
