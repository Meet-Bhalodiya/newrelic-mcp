import type { SafeAppConfig, ToolsetName } from './config/index.js';
import { safeConfig } from './config/index.js';
import type { Runtime } from './runtime.js';
import {
  ACCOUNTS_LIST,
  ACCOUNT_ACCESS,
  ALERT_POLICIES_LIST,
  CONNECTION_CHECK,
  DASHBOARDS_LIST,
  ENTITY_SEARCH,
  LOG_CONFIGURATIONS_LIST,
  MAINTENANCE_WINDOWS_LIST,
  METRIC_NORMALIZATION_RULES_LIST,
  NRQL_QUERY,
  ORGANIZATION_GET,
  SYNTHETIC_MONITORS_LIST,
  WORKLOADS_LIST,
  type NerdGraphOperation,
} from './operations/index.js';
import { redactText } from './security/index.js';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  config: SafeAppConfig;
  checks: DoctorCheck[];
};

type SchemaProbe = {
  readonly toolset: Exclude<ToolsetName, 'core'>;
  readonly operation: NerdGraphOperation;
  readonly variables: Record<string, unknown> | undefined;
};

const DOCTOR_SCHEMA_TIMEOUT_MS = 30_000;

export async function runDoctor(runtime: Runtime): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    { name: 'configuration', ok: true, message: 'Configuration is valid and secrets are loaded.' },
    {
      name: 'region',
      ok: true,
      message: `${runtime.config.newRelic.region} maps to ${runtime.client.endpoint.origin}.`,
    },
  ];

  try {
    const connection = await runtime.executor.execute(
      CONNECTION_CHECK,
      {},
      doctorExecuteOptions(runtime),
    );
    const hasUser = hasNestedObject(connection.data, ['actor', 'user']);
    const hasConnectionAccounts = hasNestedArray(connection.data, ['actor', 'accounts']);
    checks.push({
      name: 'credentials',
      ok: hasUser,
      message: hasUser
        ? 'New Relic accepted the user key.'
        : 'The connection response did not contain the expected actor user fields.',
    });

    const accounts = await runtime.executor.execute(
      ACCOUNTS_LIST,
      {},
      doctorExecuteOptions(runtime),
    );
    const accountIds = collectAccountIds(accounts.data);
    checks.push({
      name: 'accounts',
      ok: accountIds.length > 0,
      message:
        accountIds.length > 0
          ? `The key can access ${accountIds.length} account(s).`
          : 'No accessible New Relic accounts were returned.',
    });

    const missingAllowed = runtime.config.newRelic.accountAllowlist.filter(
      (accountId) => !accountIds.includes(accountId),
    );
    checks.push({
      name: 'account_allowlist',
      ok: missingAllowed.length === 0,
      message:
        missingAllowed.length === 0
          ? 'Every configured allowlisted account is accessible.'
          : `${missingAllowed.length} allowlisted account(s) are not accessible to this key.`,
    });

    if (runtime.config.newRelic.defaultAccountId !== undefined) {
      const access = await runtime.executor.execute(
        ACCOUNT_ACCESS,
        {
          accountId: runtime.config.newRelic.defaultAccountId,
        },
        doctorExecuteOptions(runtime),
      );
      const accessible =
        nestedValue(access.data, ['actor', 'account', 'id']) ===
        runtime.config.newRelic.defaultAccountId;
      checks.push({
        name: 'default_account',
        ok: accessible,
        message: accessible
          ? 'The configured default account is accessible.'
          : 'The configured default account was not returned by NerdGraph.',
      });
    }

    const expectedFields =
      hasUser &&
      hasConnectionAccounts &&
      hasNestedArray(accounts.data, ['actor', 'accounts']) &&
      connection.partial !== true &&
      accounts.partial !== true;
    checks.push({
      name: 'expected_schema',
      ok: expectedFields,
      message: expectedFields
        ? 'Required connection and account NerdGraph fields validated successfully.'
        : 'Required connection or account NerdGraph fields were absent.',
    });

    const probeAccountId = selectProbeAccountId(runtime, accountIds);
    for (const probe of schemaProbes(runtime, probeAccountId)) {
      const name = `schema_${probe.toolset}`;
      if (probe.variables === undefined) {
        checks.push({
          name,
          ok: false,
          message: `No authorized account was available for the ${probe.toolset} toolset schema probe.`,
        });
        continue;
      }
      try {
        const result = await runtime.executor.execute(
          probe.operation,
          probe.variables,
          doctorExecuteOptions(runtime),
        );
        const ok = result.partial !== true;
        checks.push({
          name,
          ok,
          message: ok
            ? `The ${probe.toolset} toolset fixed read fields validated successfully.`
            : `The ${probe.toolset} toolset schema probe returned partial data.`,
        });
      } catch (error) {
        checks.push({ name, ok: false, message: toolsetFailureMessage(probe.toolset, error) });
      }
    }
  } catch (error) {
    checks.push({
      name: 'nerdgraph',
      ok: false,
      message: publicFailureMessage(error),
    });
  }

  return { ok: checks.every((check) => check.ok), config: safeConfig(runtime.config), checks };
}

function doctorExecuteOptions(runtime: Runtime): { bypassCache: true; signal: AbortSignal } {
  return {
    bypassCache: true,
    signal: AbortSignal.timeout(
      Math.min(runtime.config.limits.timeoutMs, DOCTOR_SCHEMA_TIMEOUT_MS),
    ),
  };
}

function selectProbeAccountId(
  runtime: Runtime,
  accessibleAccountIds: readonly number[],
): number | undefined {
  const { defaultAccountId, accountAllowlist } = runtime.config.newRelic;
  if (defaultAccountId !== undefined && accessibleAccountIds.includes(defaultAccountId)) {
    return defaultAccountId;
  }
  if (accountAllowlist.length > 0) {
    return accountAllowlist.find((accountId) => accessibleAccountIds.includes(accountId));
  }
  return accessibleAccountIds[0];
}

function schemaProbes(runtime: Runtime, accountId: number | undefined): SchemaProbe[] {
  const accountVariables = (
    variables: Record<string, unknown>,
  ): Record<string, unknown> | undefined =>
    accountId === undefined ? undefined : { accountId, ...variables };
  const candidates: Readonly<Record<Exclude<ToolsetName, 'core'>, SchemaProbe>> = {
    nrql: {
      toolset: 'nrql',
      operation: NRQL_QUERY,
      variables: accountVariables({
        nrql: 'FROM Metric SELECT count(*) SINCE 5 minutes ago LIMIT 1',
      }),
    },
    entities: {
      toolset: 'entities',
      operation: ENTITY_SEARCH,
      variables:
        accountId === undefined ? undefined : { query: `accountId = ${String(accountId)}` },
    },
    alerts: {
      toolset: 'alerts',
      operation: ALERT_POLICIES_LIST,
      variables: accountVariables({}),
    },
    dashboards: {
      toolset: 'dashboards',
      operation: DASHBOARDS_LIST,
      variables:
        accountId === undefined
          ? undefined
          : { query: `type = 'DASHBOARD' AND accountId = ${String(accountId)}` },
    },
    synthetics: {
      toolset: 'synthetics',
      operation: SYNTHETIC_MONITORS_LIST,
      variables:
        accountId === undefined
          ? undefined
          : { query: `domain = 'SYNTH' AND type = 'MONITOR' AND accountId = ${String(accountId)}` },
    },
    workloads: {
      toolset: 'workloads',
      operation: WORKLOADS_LIST,
      variables:
        accountId === undefined
          ? undefined
          : { query: `accountId = ${String(accountId)} AND type = 'WORKLOAD'` },
    },
    'service-levels': {
      toolset: 'service-levels',
      operation: MAINTENANCE_WINDOWS_LIST,
      variables: { ids: ['newrelic-mcp-doctor-schema-probe'] },
    },
    logs: {
      toolset: 'logs',
      operation: LOG_CONFIGURATIONS_LIST,
      variables: accountVariables({}),
    },
    metrics: {
      toolset: 'metrics',
      operation: METRIC_NORMALIZATION_RULES_LIST,
      variables: accountVariables({}),
    },
    admin: {
      toolset: 'admin',
      operation: ORGANIZATION_GET,
      variables: {},
    },
  };

  return runtime.config.toolsets.flatMap((toolset) => {
    if (toolset === 'core' || (toolset === 'admin' && !runtime.config.gates.admin)) return [];
    return [candidates[toolset]];
  });
}

function toolsetFailureMessage(toolset: SchemaProbe['toolset'], error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return `The ${toolset} toolset schema probe failed (${redactText(code, 64)}).`;
    }
  }
  return `The ${toolset} toolset schema probe failed. Check permissions and product entitlement.`;
}

function publicFailureMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return `NerdGraph validation failed (${redactText(code, 64)}).`;
  }
  return 'NerdGraph validation failed. Check credentials, permissions, network access, and region.';
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasNestedObject(value: unknown, path: readonly string[]): boolean {
  const nested = nestedValue(value, path);
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested);
}

function hasNestedArray(value: unknown, path: readonly string[]): boolean {
  return Array.isArray(nestedValue(value, path));
}

function collectAccountIds(value: unknown): number[] {
  const ids = new Set<number>();
  const visit = (candidate: unknown, parentKey = ''): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, parentKey);
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === 'id' && parentKey === 'accounts' && typeof child === 'number') ids.add(child);
      visit(child, key);
    }
  };
  visit(value);
  return [...ids];
}
