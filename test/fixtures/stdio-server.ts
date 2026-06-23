globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as { operationName?: unknown };
  const operationName = String(body.operationName);
  const data =
    operationName === 'ConnectionCheck'
      ? {
          actor: {
            user: { id: 'stdio-user' },
            accounts: [{ id: 42, name: 'Stdio account' }],
          },
        }
      : operationName === 'AccountsList'
        ? { actor: { accounts: [{ id: 42, name: 'Stdio account' }] } }
        : operationName === 'EntityGet'
          ? {
              actor: {
                entity: {
                  guid: 'ENTITY',
                  name: 'Stdio service',
                  domain: 'APM',
                  type: 'APPLICATION',
                  accountId: 42,
                  alertSeverity: null,
                  reporting: true,
                  permalink: null,
                  tags: [],
                },
              },
            }
          : { actor: {} };
  return Response.json({ data });
};

await import('../../src/cli.js');
