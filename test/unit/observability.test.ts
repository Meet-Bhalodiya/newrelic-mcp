import { describe, expect, it } from 'vitest';

import { createObservability } from '../../src/observability.js';

describe('runtime observability', () => {
  it('uses bounded, non-sensitive metric labels', async () => {
    const observability = createObservability({ level: 'silent', collectRuntimeMetrics: false });
    observability.toolCalls.inc({ tool: 'connection_check', outcome: 'ok' });
    observability.upstreamCalls.inc({ operation: 'Viewer', status: '2xx' });

    const metrics = await observability.registry.metrics();
    expect(metrics).toContain('newrelic_mcp_tool_calls_total');
    expect(metrics).toContain('tool="connection_check"');
    expect(metrics).not.toContain('accountId');
    expect(metrics).not.toContain('nrql');
  });
});
