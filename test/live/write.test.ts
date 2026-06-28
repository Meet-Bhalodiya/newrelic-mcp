import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { ALERT_POLICY_GET, MUTATIONS } from '../../src/operations/index.js';
import { createRuntime } from '../../src/runtime.js';

const enabled =
  process.env.NEW_RELIC_LIVE_WRITE_TESTS === 'true' &&
  process.env.NEW_RELIC_LIVE_DISPOSABLE_ACCOUNT_ID !== undefined &&
  Boolean(process.env.NEW_RELIC_API_KEY ?? process.env.NEW_RELIC_API_KEY_FILE);

describe.skipIf(!enabled)('live disposable-account write lifecycle', () => {
  it('creates a uniquely prefixed alert policy, reads it back, and cleans it up', async () => {
    const accountId = Number(process.env.NEW_RELIC_LIVE_DISPOSABLE_ACCOUNT_ID);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error('NEW_RELIC_LIVE_DISPOSABLE_ACCOUNT_ID must be a positive integer.');
    }
    const config = loadConfig({
      ...process.env,
      NEW_RELIC_DEFAULT_ACCOUNT_ID: String(accountId),
      NEW_RELIC_ACCOUNT_ALLOWLIST: String(accountId),
      NEW_RELIC_ENABLE_WRITES: 'true',
      NEW_RELIC_ENABLE_DESTRUCTIVE: 'true',
    });
    const runtime = createRuntime(config);
    const name = `newrelic-mcp-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let policyId: string | undefined;

    try {
      const created = await runtime.executor.execute(MUTATIONS.alertPolicyCreate, {
        accountId,
        policy: { name, incidentPreference: 'PER_POLICY' },
      });
      policyId = findString(created.data, 'id');
      expect(policyId).toBeDefined();

      const readback = await runtime.executor.execute(ALERT_POLICY_GET, {
        accountId,
        id: policyId,
      });
      expect(JSON.stringify(readback.data)).toContain(name);
    } finally {
      if (policyId !== undefined) {
        await runtime.executor.execute(MUTATIONS.alertPolicyDelete, { accountId, id: policyId });
      }
    }
  });
});

function findString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findString(child, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (childKey === key && (typeof child === 'string' || typeof child === 'number')) {
      return String(child);
    }
    const found = findString(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
