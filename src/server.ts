import { randomUUID } from 'node:crypto';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import { normalizePublicError } from './error-mapping.js';
import { NewRelicMcpError } from './errors.js';
import { buildPromptDefinitions, SERVER_INSTRUCTIONS } from './prompts/index.js';
import { buildResourceDefinitions } from './resources/index.js';
import { asToolResult, errorEnvelope, toolEnvelopeSchema } from './results.js';
import type { Runtime } from './runtime.js';
import { buildToolDefinitions, type ToolExecutionContext } from './toolsets/index.js';
import { withSpan } from './tracing.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type McpRequestSignalContext = {
  readonly signalForRequest: (requestId: string | number, sdkSignal: AbortSignal) => AbortSignal;
};

export function createMcpServer(
  runtime: Runtime,
  requestContext?: McpRequestSignalContext,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'New Relic MCP Server' },
    {
      instructions: SERVER_INSTRUCTIONS,
      enforceStrictCapabilities: true,
    },
  );
  const context = toolContext(runtime);

  for (const definition of buildToolDefinitions(context)) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: toolEnvelopeSchema,
        annotations: definition.annotations,
        _meta: {
          'newrelic/toolset': definition.toolset,
          'newrelic/requiredScope': definition.requiredScope,
          'newrelic/source': definition.sourceUrl,
        },
      },
      async (arguments_, extra) => {
        const startedAt = performance.now();
        const currentRequestId = randomUUID();
        const executionMode = definition.annotations.readOnlyHint
          ? 'read'
          : arguments_.dryRun === false
            ? 'apply'
            : 'dry-run';
        let outcome: string | undefined;
        try {
          requireToolScope(extra.authInfo?.scopes, definition.requiredScope);
          const result = await withSpan(
            'mcp.tool.call',
            {
              'mcp.tool.name': definition.name,
              'mcp.tool.read_only': definition.annotations.readOnlyHint,
            },
            async () =>
              await definition.handler(arguments_, {
                requestId: currentRequestId,
                signal:
                  requestContext?.signalForRequest(extra.requestId, extra.signal) ?? extra.signal,
              }),
            runtime.config.telemetry.enabled,
          );
          const envelope = toolEnvelopeSchema.parse(result.structuredContent);
          outcome = envelope.meta.partial ? 'partial' : 'ok';
          const bounded = asToolResult(envelope, runtime.config.limits.maxResponseBytes);
          if (bounded.structuredContent.meta.truncated) {
            runtime.observability.truncations.inc({ tool: definition.name });
          }
          return bounded;
        } catch (error) {
          const normalized = normalizePublicError(error);
          outcome = normalized.code;
          runtime.observability.logger.warn(
            {
              event: 'tool_call_failed',
              requestId: currentRequestId,
              tool: definition.name,
              mode: executionMode,
              code: normalized.code,
              retryable: normalized.retryable,
            },
            'MCP tool call failed',
          );
          const bounded = asToolResult(
            errorEnvelope(normalized.toPublic(), {
              requestId: currentRequestId,
              region: runtime.config.newRelic.region,
              durationMs: performance.now() - startedAt,
            }),
            runtime.config.limits.maxResponseBytes,
          );
          if (bounded.structuredContent.meta.truncated) {
            runtime.observability.truncations.inc({ tool: definition.name });
          }
          return bounded;
        } finally {
          const finalOutcome = outcome ?? 'error';
          const durationSeconds = (performance.now() - startedAt) / 1000;
          runtime.observability.toolCalls.inc({ tool: definition.name, outcome: finalOutcome });
          runtime.observability.toolDuration.observe(
            { tool: definition.name, outcome: finalOutcome },
            durationSeconds,
          );
          runtime.observability.logger.info(
            {
              event: 'tool_call',
              requestId: currentRequestId,
              tool: definition.name,
              mode: executionMode,
              outcome: finalOutcome,
              durationMs: Math.round(durationSeconds * 1000),
            },
            'MCP tool call completed',
          );
        }
      },
    );
  }

  for (const definition of buildResourceDefinitions(context)) {
    if (definition.uri.includes('{')) {
      server.registerResource(
        definition.name,
        new ResourceTemplate(definition.uri, { list: undefined }),
        {
          title: definition.title,
          description: definition.description,
          mimeType: definition.mimeType,
        },
        async (_uri, variables, extra) => {
          const result = await definition.read(variables, {
            signal: requestContext?.signalForRequest(extra.requestId, extra.signal) ?? extra.signal,
          });
          return { contents: result.contents.map((content) => ({ ...content })) };
        },
      );
    } else {
      server.registerResource(
        definition.name,
        definition.uri,
        {
          title: definition.title,
          description: definition.description,
          mimeType: definition.mimeType,
        },
        async (_uri, extra) => {
          const result = await definition.read(
            {},
            {
              signal:
                requestContext?.signalForRequest(extra.requestId, extra.signal) ?? extra.signal,
            },
          );
          return { contents: result.contents.map((content) => ({ ...content })) };
        },
      );
    }
  }

  for (const definition of buildPromptDefinitions()) {
    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        argsSchema: definition.argumentsSchema.shape,
      },
      (arguments_) => {
        const result = definition.get(arguments_);
        return {
          messages: result.messages.map((message) => ({
            role: message.role,
            content: { ...message.content },
          })),
        };
      },
    );
  }

  return server;
}

function toolContext(runtime: Runtime): ToolExecutionContext {
  return {
    executor: runtime.executor,
    gates: {
      enabledToolsets: runtime.config.toolsets,
      writes: runtime.config.gates.writes,
      destructive: runtime.config.gates.destructive,
      admin: runtime.config.gates.admin,
      previewApis: runtime.config.gates.previewApis,
      experimentalAiIssues: runtime.config.gates.experimentalAiIssues,
    },
    ...(runtime.config.newRelic.defaultAccountId === undefined
      ? {}
      : { defaultAccountId: runtime.config.newRelic.defaultAccountId }),
    accountAllowlist: runtime.config.newRelic.accountAllowlist,
    region: runtime.config.newRelic.region,
    maxResponseBytes: runtime.config.limits.maxResponseBytes,
    requestId: () => randomUUID(),
  };
}

function requireToolScope(scopes: readonly string[] | undefined, requiredScope: string): void {
  // Stdio has no HTTP principal; local process access and feature gates are its authorization boundary.
  if (scopes === undefined) return;
  if (!scopes.includes(requiredScope)) {
    throw new NewRelicMcpError('authorization', 'The bearer token lacks the required scope.', {
      details: { requiredScopes: [requiredScope] },
    });
  }
}
