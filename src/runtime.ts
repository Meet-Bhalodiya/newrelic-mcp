import type { AppConfig } from './config/index.js';
import { InstrumentedOperationExecutor } from './executor.js';
import { NerdGraphClient } from './newrelic/index.js';
import { createObservability, type RuntimeObservability } from './observability.js';

export type Runtime = {
  config: AppConfig;
  client: NerdGraphClient;
  executor: InstrumentedOperationExecutor;
  observability: RuntimeObservability;
};

export function createRuntime(config: AppConfig): Runtime {
  const observability = createObservability({
    level: config.logging.level,
    collectRuntimeMetrics: config.http.exposeMetrics,
  });
  const client = new NerdGraphClient({
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
    cacheTtlMs: config.limits.cacheTtlMs,
    cacheMaxEntries: config.limits.cacheMaxEntries,
  });
  const executor = new InstrumentedOperationExecutor(
    client,
    observability,
    config.telemetry.enabled,
  );
  return { config, client, executor, observability };
}
