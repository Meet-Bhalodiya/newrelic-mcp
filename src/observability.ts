import pino, { type Logger } from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type RuntimeObservability = {
  logger: Logger;
  registry: Registry;
  toolCalls: Counter<'tool' | 'outcome'>;
  toolDuration: Histogram<'tool' | 'outcome'>;
  upstreamCalls: Counter<'operation' | 'status'>;
  upstreamDuration: Histogram<'operation' | 'status'>;
  queueDepth: Gauge<'queue'>;
  retries: Counter<'operation'>;
  rateLimits: Counter<'source'>;
  truncations: Counter<'tool'>;
  cache: Counter<'result'>;
};

export function createObservability(options: {
  level: string;
  pretty?: boolean;
  collectRuntimeMetrics?: boolean;
}): RuntimeObservability {
  const logger = pino(
    {
      level: options.level,
      base: null,
      redact: {
        paths: [
          'apiKey',
          '*.apiKey',
          'token',
          '*.token',
          'authorization',
          '*.authorization',
          'headers',
          '*.headers',
          'query',
          '*.query',
          'variables',
          '*.variables',
          'input',
          '*.input',
          'response',
          '*.response',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.destination({ dest: 2, sync: false }),
  );

  const registry = new Registry();
  if (options.collectRuntimeMetrics !== false) collectDefaultMetrics({ register: registry });

  const toolCalls = new Counter({
    name: 'newrelic_mcp_tool_calls_total',
    help: 'MCP tool calls by tool and outcome.',
    labelNames: ['tool', 'outcome'],
    registers: [registry],
  });
  const toolDuration = new Histogram({
    name: 'newrelic_mcp_tool_duration_seconds',
    help: 'MCP tool duration.',
    labelNames: ['tool', 'outcome'],
    registers: [registry],
  });
  const upstreamCalls = new Counter({
    name: 'newrelic_mcp_upstream_calls_total',
    help: 'Sanitized NerdGraph calls by fixed operation and status class.',
    labelNames: ['operation', 'status'],
    registers: [registry],
  });
  const upstreamDuration = new Histogram({
    name: 'newrelic_mcp_upstream_duration_seconds',
    help: 'NerdGraph request duration.',
    labelNames: ['operation', 'status'],
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: 'newrelic_mcp_queue_depth',
    help: 'Queued operations by bounded queue.',
    labelNames: ['queue'],
    registers: [registry],
  });
  const retries = new Counter({
    name: 'newrelic_mcp_retries_total',
    help: 'Read retries by fixed operation.',
    labelNames: ['operation'],
    registers: [registry],
  });
  const rateLimits = new Counter({
    name: 'newrelic_mcp_rate_limits_total',
    help: 'Rate limit responses by source.',
    labelNames: ['source'],
    registers: [registry],
  });
  const truncations = new Counter({
    name: 'newrelic_mcp_truncations_total',
    help: 'Truncated MCP responses by tool.',
    labelNames: ['tool'],
    registers: [registry],
  });
  const cache = new Counter({
    name: 'newrelic_mcp_cache_total',
    help: 'Cache hit and miss counts.',
    labelNames: ['result'],
    registers: [registry],
  });

  return {
    logger,
    registry,
    toolCalls,
    toolDuration,
    upstreamCalls,
    upstreamDuration,
    queueDepth,
    retries,
    rateLimits,
    truncations,
    cache,
  };
}
