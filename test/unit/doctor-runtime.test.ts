import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { runDoctor } from '../../src/doctor.js';
import { NerdGraphError } from '../../src/newrelic/index.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { createMockRuntime } from '../helpers/runtime.js';

describe('doctor and runtime assembly', () => {
  it('reports validated credentials, accounts, allowlist, default account, and schema', async () => {
    const { runtime, operationNames } = createMockRuntime({
      NEW_RELIC_DEFAULT_ACCOUNT_ID: '42',
      NEW_RELIC_ACCOUNT_ALLOWLIST: '42',
      NEW_RELIC_TOOLSETS: 'core',
    });
    const report = await runDoctor(runtime);
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'configuration',
        'region',
        'credentials',
        'accounts',
        'account_allowlist',
        'default_account',
        'expected_schema',
      ]),
    );
    expect(operationNames).toEqual(['ConnectionCheck', 'AccountsList', 'AccountAccess']);
    expect(JSON.stringify(report.config)).not.toContain('NRAK-test-only');
  });

  it('runs one bounded fixed read schema probe for every effectively enabled toolset', async () => {
    const { runtime } = createMockRuntime({
      NEW_RELIC_TOOLSETS: 'all',
      NEW_RELIC_ENABLE_ADMIN: 'true',
    });
    const operationNames: string[] = [];
    const variables: Record<string, unknown>[] = [];
    const execute = vi.fn(async (operation, input) => {
      operationNames.push(operation.name);
      variables.push(input);
      if (operation.name === 'ConnectionCheck') {
        return {
          data: {
            actor: {
              user: { id: 1 },
              accounts: [{ id: 42, name: 'Test' }],
            },
          },
          partial: false,
        };
      }
      if (operation.name === 'AccountsList') {
        return {
          data: { actor: { accounts: [{ id: 42, name: 'Test' }] } },
          partial: false,
        };
      }
      if (operation.name === 'AccountAccess') {
        return {
          data: { actor: { account: { id: 42, name: 'Test' } } },
          partial: false,
        };
      }
      return { data: {}, partial: false };
    });
    const report = await runDoctor({ ...runtime, executor: { execute } } as unknown as Runtime);

    expect(report.ok).toBe(true);
    expect(operationNames).toEqual([
      'ConnectionCheck',
      'AccountsList',
      'AccountAccess',
      'NrqlQuery',
      'EntitySearch',
      'AlertPoliciesList',
      'DashboardsList',
      'SyntheticMonitorsList',
      'WorkloadsList',
      'MaintenanceWindowsList',
      'LogConfigurationsList',
      'MetricNormalizationRulesList',
      'OrganizationGet',
    ]);
    expect(report.checks.filter(({ name }) => name.startsWith('schema_'))).toHaveLength(10);
    expect(variables).toContainEqual({
      accountId: 42,
      nrql: 'FROM Metric SELECT count(*) SINCE 5 minutes ago LIMIT 1',
    });
    expect(variables).toContainEqual({ query: "type = 'DASHBOARD' AND accountId = 42" });
    expect(variables).toContainEqual({ ids: ['newrelic-mcp-doctor-schema-probe'] });
    expect(execute.mock.calls.every(([operation]) => operation.kind === 'query')).toBe(true);
  });

  it('reports one toolset schema failure and continues the remaining probes', async () => {
    const { runtime } = createMockRuntime({ NEW_RELIC_TOOLSETS: 'core,logs,metrics' });
    const execute = vi.fn(async (operation) => {
      if (operation.name === 'ConnectionCheck') {
        return {
          data: { actor: { user: { id: 1 }, accounts: [{ id: 42, name: 'Test' }] } },
          partial: false,
        };
      }
      if (operation.name === 'AccountsList') {
        return {
          data: { actor: { accounts: [{ id: 42, name: 'Test' }] } },
          partial: false,
        };
      }
      if (operation.name === 'AccountAccess') {
        return { data: { actor: { account: { id: 42 } } }, partial: false };
      }
      if (operation.name === 'LogConfigurationsList') {
        throw new NerdGraphError('authorization', 'secret permission detail');
      }
      return { data: {}, partial: false };
    });
    const report = await runDoctor({ ...runtime, executor: { execute } } as unknown as Runtime);

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: 'schema_logs',
      ok: false,
      message: 'The logs toolset schema probe failed (authorization).',
    });
    expect(report.checks).toContainEqual({
      name: 'schema_metrics',
      ok: true,
      message: 'The metrics toolset fixed read fields validated successfully.',
    });
    expect(JSON.stringify(report)).not.toContain('secret permission detail');
  });

  it('returns a sanitized failed check without exposing an upstream exception', async () => {
    const { runtime } = createMockRuntime();
    const execute = vi
      .fn()
      .mockRejectedValue(new NerdGraphError('authentication', 'secret upstream detail'));
    const failedRuntime = {
      ...runtime,
      executor: { execute },
    } as unknown as Runtime;
    const report = await runDoctor(failedRuntime);
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({
      name: 'nerdgraph',
      ok: false,
      message: 'NerdGraph validation failed (authentication).',
    });
    expect(JSON.stringify(report)).not.toContain('secret upstream detail');
  });

  it('fails doctor when the default account query returns null', async () => {
    const { runtime } = createMockRuntime(
      {
        NEW_RELIC_DEFAULT_ACCOUNT_ID: '42',
        NEW_RELIC_ACCOUNT_ALLOWLIST: '42',
        NEW_RELIC_TOOLSETS: 'core',
      },
      (operationName) =>
        operationName === 'AccountAccess' ? { actor: { account: null } } : undefined,
    );
    const report = await runDoctor(runtime);

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: 'default_account',
      ok: false,
      message: 'The configured default account was not returned by NerdGraph.',
    });
  });

  it('prints configuration failures as machine-readable doctor JSON', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'doctor', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NEW_RELIC_API_KEY: '', NEW_RELIC_API_KEY_FILE: '' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      config: null,
      checks: [{ name: 'configuration', ok: false }],
    });
  });

  it('assembles the production runtime from typed configuration', () => {
    const config = loadConfig({
      NEW_RELIC_API_KEY: 'NRAK-runtime-test',
      NEW_RELIC_REGION: 'EU',
      NEW_RELIC_CONCURRENCY: '7',
      NEW_RELIC_NRQL_CONCURRENCY: '3',
      LOG_LEVEL: 'silent',
    });
    const runtime = createRuntime(config);
    expect(runtime.config).toBe(config);
    expect(runtime.client.endpoint.toString()).toBe('https://api.eu.newrelic.com/graphql');
    expect(runtime.client.stats.requests.limit).toBe(7);
    expect(runtime.client.stats.nrql.limit).toBe(3);
    expect(runtime.observability.logger.level).toBe('silent');
  });
});
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
