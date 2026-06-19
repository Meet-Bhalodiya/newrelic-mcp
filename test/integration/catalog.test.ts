import { describe, expect, it, vi } from 'vitest';

import { buildPromptDefinitions, SERVER_INSTRUCTIONS } from '../../src/prompts/index.js';
import { buildResourceDefinitions } from '../../src/resources/index.js';
import type { NerdGraphOperation } from '../../src/operations/index.js';

describe('resource and prompt catalogs', () => {
  const context = {
    executor: {
      execute: async (operation: NerdGraphOperation) => ({
        data:
          operation.operationName === 'AccountsList'
            ? {
                actor: {
                  accounts: [
                    { id: 1, name: 'allowed' },
                    { id: 2, name: 'hidden' },
                  ],
                },
              }
            : operation.operationName === 'AlertPolicyGet'
              ? {
                  actor: {
                    account: { id: 1, alerts: { policy: { id: 'policy', name: 'Policy' } } },
                  },
                }
              : { actor: { entity: { guid: 'entity', accountId: 1 } } },
      }),
    },
    gates: {},
    accountAllowlist: [1],
    defaultAccountId: 1,
  } as const;

  it('exposes the required static and templated resources', () => {
    expect(buildResourceDefinitions(context).map(({ uri }) => uri)).toEqual([
      'newrelic://server/capabilities',
      'newrelic://accounts',
      'newrelic://entities/{guid}',
      'newrelic://dashboards/{guid}',
      'newrelic://alert-policies/{accountId}/{id}',
      'newrelic://synthetic-monitors/{guid}',
      'newrelic://workloads/{guid}',
      'newrelic://service-levels/{entityGuid}/{id}',
    ]);
  });

  it('filters account resources', async () => {
    const accounts = buildResourceDefinitions(context).find(({ name }) => name === 'accounts');
    const result = await accounts?.read({});
    expect(result?.contents[0]?.text).toContain('allowed');
    expect(result?.contents[0]?.text).not.toContain('hidden');
  });

  it('coerces URI account IDs', async () => {
    const policy = buildResourceDefinitions(context).find(({ name }) => name === 'alert_policy');
    await expect(policy?.read({ accountId: '1', id: 'policy' })).resolves.toBeDefined();
  });

  it('rejects disallowed resource accounts before executor I/O', async () => {
    const execute = vi.fn(async () => ({ data: {} }));
    const resources = buildResourceDefinitions({
      ...context,
      executor: { execute },
      accountAllowlist: [1],
    });
    const policy = resources.find(({ name }) => name === 'alert_policy');

    await expect(policy?.read({ accountId: '2', id: 'policy' })).rejects.toMatchObject({
      code: 'authorization',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns typed not-found errors for absent templated resources', async () => {
    const resources = buildResourceDefinitions({
      ...context,
      accountAllowlist: [],
      executor: {
        execute: async (operation: NerdGraphOperation) => ({
          data:
            operation.operationName === 'AlertPolicyGet'
              ? { actor: { account: { id: 1, alerts: { policy: null } } } }
              : { actor: { entity: null } },
        }),
      },
    });
    const reads = [
      ['entity', { guid: 'entity' }],
      ['dashboard', { guid: 'entity' }],
      ['alert_policy', { accountId: 1, id: 'policy' }],
      ['synthetic_monitor', { guid: 'entity' }],
      ['workload', { guid: 'entity' }],
      ['service_level', { entityGuid: 'entity', id: 'sli' }],
    ] as const;

    for (const [name, parameters] of reads) {
      const definition = resources.find((candidate) => candidate.name === name);
      await expect(definition?.read(parameters)).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('hard-bounds serialized resource output', async () => {
    const resources = buildResourceDefinitions({
      ...context,
      maxResponseBytes: 1024,
      accountAllowlist: [],
      executor: {
        execute: async () => ({
          data: { actor: { accounts: [{ id: 1, name: 'x'.repeat(10_000) }] } },
        }),
      },
    });
    const accounts = resources.find(({ name }) => name === 'accounts');
    const result = await accounts?.read({});
    const text = result?.contents[0]?.text ?? '';

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
    expect(JSON.parse(text)).toMatchObject({ data: { omitted: true }, truncated: true });
    expect(text).not.toContain('x'.repeat(100));
  });

  it('filters resource templates by toolset and narrows a service-level result by ID', async () => {
    const serviceContext = {
      ...context,
      gates: { enabledToolsets: ['service-levels'] as const },
      executor: {
        execute: async () => ({
          data: {
            actor: {
              entity: {
                accountId: 1,
                serviceLevel: {
                  indicators: [
                    { id: 'wanted', name: 'Wanted' },
                    { id: 'other', name: 'Other' },
                  ],
                },
              },
            },
          },
        }),
      },
    };
    const resources = buildResourceDefinitions(serviceContext);
    expect(resources.map(({ name }) => name)).toEqual(['server_capabilities', 'service_level']);
    const serviceLevel = resources.find(({ name }) => name === 'service_level');
    const result = await serviceLevel?.read({ entityGuid: 'entity', id: 'wanted' });
    const parsed = JSON.parse(result?.contents[0]?.text ?? '{}') as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain('Wanted');
    expect(JSON.stringify(parsed)).not.toContain('Other');
  });

  it('publishes all workflow prompts and accepts string MCP arguments', () => {
    const prompts = buildPromptDefinitions();
    expect(prompts.map(({ name }) => name)).toEqual([
      'incident_triage',
      'service_health',
      'alert_policy_review',
      'slo_review',
      'dashboard_design',
      'synthetic_failure_analysis',
    ]);
    const triage = prompts.find(({ name }) => name === 'incident_triage');
    expect(triage?.get({ accountId: '1' }).messages[0]?.content.text).toContain('account 1');
  });

  it('front-loads the critical server safety instructions', () => {
    expect(SERVER_INSTRUCTIONS.slice(0, 512)).toContain('read-only by default');
    expect(SERVER_INSTRUCTIONS.slice(0, 512)).toContain('Every write starts with dry-run');
    expect(SERVER_INSTRUCTIONS).toContain('Never expose secure credentials');
  });
});
