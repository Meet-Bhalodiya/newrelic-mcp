import type { AppConfig } from '../../src/config/index.js';
import { loadConfig } from '../../src/config/index.js';
import { InstrumentedOperationExecutor } from '../../src/executor.js';
import { NerdGraphClient } from '../../src/newrelic/index.js';
import { createObservability } from '../../src/observability.js';
import type { Runtime } from '../../src/runtime.js';

export type MockNerdGraph = {
  runtime: Runtime;
  operationNames: string[];
  bodies: Record<string, unknown>[];
};

type MockResponseData =
  Record<string, unknown> | readonly unknown[] | string | number | boolean | null;

export function createMockRuntime(
  environment: Record<string, string> = {},
  respond?: (
    operationName: string,
    body: Record<string, unknown>,
  ) => MockResponseData | undefined | PromiseLike<MockResponseData | undefined>,
): MockNerdGraph {
  const config = loadConfig({
    NEW_RELIC_API_KEY: 'NRAK-test-only',
    NEW_RELIC_DEFAULT_ACCOUNT_ID: '42',
    LOG_LEVEL: 'silent',
    ...environment,
  });
  const operationNames: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const operationName = String(body.operationName);
    operationNames.push(operationName);
    bodies.push(body);
    const supplied = await Promise.resolve(respond?.(operationName, body));
    const data = supplied === undefined ? defaultData(operationName) : supplied;
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const observability = createObservability({ level: 'silent', collectRuntimeMetrics: false });
  const client = clientFor(config, fetch);
  const executor = new InstrumentedOperationExecutor(client, observability);
  return {
    runtime: { config, client, executor, observability },
    operationNames,
    bodies,
  };
}

function clientFor(config: AppConfig, fetch: typeof globalThis.fetch): NerdGraphClient {
  return new NerdGraphClient({
    apiKey: config.newRelic.apiKey,
    endpoint: config.newRelic.endpoint,
    region: config.newRelic.region,
    concurrency: config.limits.concurrency,
    nrqlConcurrency: config.limits.nrqlConcurrency,
    timeoutMs: config.limits.timeoutMs,
    nrqlTimeoutMs: config.limits.nrqlTimeoutMs,
    maxResponseBytes: config.limits.maxResponseBytes,
    allowMutations: config.gates.writes,
    accountPolicy: {
      defaultAccountId: config.newRelic.defaultAccountId,
      accountAllowlist: config.newRelic.accountAllowlist,
    },
    cacheTtlMs: 0,
    cacheMaxEntries: 0,
    fetch,
    sleep: async () => await Promise.resolve(),
    random: () => 0,
  });
}

function defaultData(operationName: string): unknown {
  if (operationName === 'ConnectionCheck') {
    return { actor: { user: { id: 1, name: 'Test User' }, accounts: [{ id: 42, name: 'Test' }] } };
  }
  if (operationName === 'AccountsList') {
    return { actor: { accounts: [{ id: 42, name: 'Test' }] } };
  }
  if (operationName === 'AccountAccess') {
    return { actor: { account: { id: 42, name: 'Test' } } };
  }
  if (operationName === 'EntityGet') {
    return {
      actor: {
        entity: {
          guid: 'ENTITY',
          name: 'Service',
          accountId: 42,
          domain: 'APM',
          type: 'APPLICATION',
          alertSeverity: null,
          reporting: null,
          permalink: null,
          tags: [],
        },
      },
    };
  }
  if (operationName === 'EntityTagsAdd') {
    return { taggingAddTagsToEntity: { errors: [] } };
  }
  if (operationName === 'OrganizationGet') {
    return { actor: { organization: { id: 'organization', name: 'Test Organization' } } };
  }
  if (operationName.includes('Nrql') || operationName === 'ServiceLevelResults') {
    return { actor: { account: { nrql: { results: [{ count: 1 }], metadata: {} } } } };
  }
  if (
    /Create|Update|Delete|Add|Remove|Replace|Cancel|Acknowledge|Resolve|Enable|Disable/u.test(
      operationName,
    )
  ) {
    return { mutationResult: { errors: [] } };
  }
  return { actor: {} };
}
