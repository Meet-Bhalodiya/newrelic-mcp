import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { ACCOUNT_ACCESS, CONNECTION_CHECK, NRQL_QUERY } from '../../src/operations/index.js';
import { createRuntime } from '../../src/runtime.js';

const enabled =
  process.env.NEW_RELIC_LIVE_TESTS === 'true' &&
  Boolean(process.env.NEW_RELIC_API_KEY ?? process.env.NEW_RELIC_API_KEY_FILE);

describe.skipIf(!enabled)('live read-only NerdGraph smoke', () => {
  it('validates credentials, account access, schema, and a bounded NRQL query', async () => {
    const config = loadConfig(process.env);
    const accountId = liveAccountId(config.newRelic.defaultAccountId);
    const runtime = createRuntime(config);

    await expect(runtime.executor.execute(CONNECTION_CHECK, {})).resolves.toMatchObject({
      partial: false,
    });
    await expect(runtime.executor.execute(ACCOUNT_ACCESS, { accountId })).resolves.toMatchObject({
      partial: false,
    });
    await expect(
      runtime.executor.execute(NRQL_QUERY, {
        accountId,
        nrql: 'FROM Transaction SELECT count(*) SINCE 5 minutes ago LIMIT 1',
      }),
    ).resolves.toMatchObject({ partial: false });
  });
});

function liveAccountId(defaultAccountId: number | undefined): number {
  const raw = process.env.NEW_RELIC_LIVE_TEST_ACCOUNT_ID ?? process.env.NEW_RELIC_LIVE_ACCOUNT_ID;
  const accountId = raw === undefined ? defaultAccountId : Number(raw);
  if (accountId === undefined || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(
      'Set NEW_RELIC_LIVE_TEST_ACCOUNT_ID or NEW_RELIC_DEFAULT_ACCOUNT_ID to run live tests.',
    );
  }
  return accountId;
}
