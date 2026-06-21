import { z, type ZodObject, type ZodRawShape } from 'zod';

import {
  ACCOUNTS_LIST,
  ALERT_POLICY_GET,
  DASHBOARD_GET,
  ENTITY_GET,
  SERVICE_LEVEL_GET,
  SYNTHETIC_MONITOR_GET,
  WORKLOAD_GET,
  guidSchema,
  type NerdGraphOperation,
} from '../operations/index.js';
import { catalogByToolset, EXCLUDED_CAPABILITIES } from '../toolsets/catalog.js';
import { enabledToolNames } from '../toolsets/build.js';
import { CapabilityError } from '../toolsets/errors.js';
import { assertAccountAllowlist, filterResponseToAccountAllowlist } from '../toolsets/safety.js';
import type { ToolExecutionContext, ToolsetName } from '../toolsets/types.js';
import { MCP_PROTOCOL_VERSION } from '../version.js';

export interface ResourceReadResult {
  readonly contents: readonly {
    readonly uri: string;
    readonly mimeType: 'application/json';
    readonly text: string;
  }[];
}

export interface ResourceDefinition<Shape extends ZodRawShape = ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly uri: string;
  readonly mimeType: 'application/json';
  readonly parametersSchema: ZodObject<Shape>;
  readonly toolset?: ToolsetName;
  readonly read: (
    parameters: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ResourceReadResult>;
}

function boundedResourceText(value: unknown, maximumBytes: number, uri: string): string {
  const text = JSON.stringify(value);
  if (serializedResourceBytes(uri, text) <= maximumBytes) return text;
  const fallback = JSON.stringify({
    ok: true,
    data: { omitted: true },
    partial: false,
    truncated: true,
    warnings: ['Resource output exceeded the configured response limit.'],
  });
  if (serializedResourceBytes(uri, fallback) > maximumBytes) {
    throw new RangeError('Configured MCP response limit is too small for a resource envelope');
  }
  return fallback;
}

function serializedResourceBytes(uri: string, text: string): number {
  return Buffer.byteLength(
    JSON.stringify({ contents: [{ uri, mimeType: 'application/json', text }] }),
    'utf8',
  );
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function requireResourceAtPath(
  path: readonly string[],
  resourceName: string,
): (data: unknown, parameters: Record<string, unknown>) => void {
  return (data, parameters) => {
    const resource = valueAtPath(data, path);
    if (resource === null || resource === undefined) {
      throw new CapabilityError('not_found', `${resourceName} was not found`, {
        identifier: parameters.id ?? parameters.guid ?? parameters.entityGuid,
      });
    }
  };
}

function resource(
  context: ToolExecutionContext,
  options: {
    name: string;
    title: string;
    description: string;
    uri: string;
    parametersSchema: ZodObject<ZodRawShape>;
    operation: NerdGraphOperation;
    toolset?: ToolsetName;
    mapVariables?: (parameters: Record<string, unknown>) => Record<string, unknown>;
    mapResult?: (data: unknown, parameters: Record<string, unknown>) => unknown;
    validateResult?: (data: unknown, parameters: Record<string, unknown>) => void;
  },
): ResourceDefinition {
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    uri: options.uri,
    mimeType: 'application/json',
    parametersSchema: options.parametersSchema,
    ...(options.toolset === undefined ? {} : { toolset: options.toolset }),
    read: async (rawParameters, readOptions) => {
      const parsed = options.parametersSchema.parse(rawParameters);
      const withDefaultAccount =
        options.operation.document.includes('$accountId') && parsed.accountId === undefined
          ? { ...parsed, accountId: context.defaultAccountId }
          : parsed;
      const candidateVariables = options.mapVariables?.(withDefaultAccount) ?? withDefaultAccount;
      assertAccountAllowlist(candidateVariables, context);
      const declaredVariables = new Set(
        [...options.operation.document.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/gu)].map(
          (match) => match[1],
        ),
      );
      const variables = Object.fromEntries(
        Object.entries(candidateVariables).filter(([key]) => declaredVariables.has(key)),
      );
      const result = await context.executor.execute(options.operation, variables, {
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      });
      const uri = options.uri.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, key: string) => {
        const value = withDefaultAccount[key];
        return encodeURIComponent(
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : '',
        );
      });
      const authorizedData = filterResponseToAccountAllowlist(result.data, context);
      options.validateResult?.(authorizedData, withDefaultAccount);
      const mappedData = options.mapResult?.(authorizedData, withDefaultAccount) ?? authorizedData;
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: boundedResourceText(
              {
                ok: true,
                data: mappedData,
                partial: result.partial === true,
                truncated: result.truncated === true,
                warnings: result.warnings ?? [],
              },
              context.maxResponseBytes ?? 1024 * 1024,
              uri,
            ),
          },
        ],
      };
    },
  };
}

export function buildResourceDefinitions(
  context: ToolExecutionContext,
): readonly ResourceDefinition[] {
  const definitions: ResourceDefinition[] = [
    {
      name: 'server_capabilities',
      title: 'New Relic MCP capabilities',
      description: 'Enabled toolsets, safety gates, tools, and deliberately excluded capabilities.',
      uri: 'newrelic://server/capabilities',
      mimeType: 'application/json',
      parametersSchema: z.object({}).strict(),
      read: () =>
        Promise.resolve({
          contents: [
            {
              uri: 'newrelic://server/capabilities',
              mimeType: 'application/json',
              text: boundedResourceText(
                {
                  protocolVersion: MCP_PROTOCOL_VERSION,
                  transportModel: 'stdio-or-stateless-streamable-http',
                  toolsets: catalogByToolset(),
                  enabledTools: enabledToolNames(context.gates),
                  gates: {
                    writes: context.gates.writes === true,
                    destructive: context.gates.destructive === true,
                    admin: context.gates.admin === true,
                    previewApis: context.gates.previewApis === true,
                    experimentalAiIssues: context.gates.experimentalAiIssues === true,
                  },
                  excluded: EXCLUDED_CAPABILITIES,
                },
                context.maxResponseBytes ?? 1024 * 1024,
                'newrelic://server/capabilities',
              ),
            },
          ],
        }),
    },
    resource(context, {
      name: 'accounts',
      title: 'Accessible New Relic accounts',
      description: 'Accounts accessible to the configured server-side user key.',
      uri: 'newrelic://accounts',
      parametersSchema: z.object({}).strict(),
      operation: ACCOUNTS_LIST,
      toolset: 'core',
    }),
    resource(context, {
      name: 'entity',
      title: 'New Relic entity',
      description: 'Entity identity, health, reporting status, metadata, and tags.',
      uri: 'newrelic://entities/{guid}',
      parametersSchema: z.object({ guid: guidSchema }).strict(),
      operation: ENTITY_GET,
      validateResult: requireResourceAtPath(['actor', 'entity'], 'Entity'),
      toolset: 'entities',
    }),
    resource(context, {
      name: 'dashboard',
      title: 'New Relic dashboard',
      description: 'Complete non-secret dashboard definition.',
      uri: 'newrelic://dashboards/{guid}',
      parametersSchema: z.object({ guid: guidSchema }).strict(),
      operation: DASHBOARD_GET,
      validateResult: requireResourceAtPath(['actor', 'entity'], 'Dashboard'),
      toolset: 'dashboards',
    }),
    resource(context, {
      name: 'alert_policy',
      title: 'New Relic alert policy',
      description: 'Alert policy configuration by account and policy ID.',
      uri: 'newrelic://alert-policies/{accountId}/{id}',
      parametersSchema: z
        .object({ accountId: z.coerce.number().int().positive(), id: z.string().min(1).max(512) })
        .strict(),
      operation: ALERT_POLICY_GET,
      validateResult: requireResourceAtPath(
        ['actor', 'account', 'alerts', 'policy'],
        'Alert policy',
      ),
      toolset: 'alerts',
    }),
    resource(context, {
      name: 'synthetic_monitor',
      title: 'New Relic synthetic monitor',
      description: 'Synthetic monitor metadata without scripts or secure credential values.',
      uri: 'newrelic://synthetic-monitors/{guid}',
      parametersSchema: z.object({ guid: guidSchema }).strict(),
      operation: SYNTHETIC_MONITOR_GET,
      validateResult: requireResourceAtPath(['actor', 'entity'], 'Synthetic monitor'),
      toolset: 'synthetics',
    }),
    resource(context, {
      name: 'workload',
      title: 'New Relic workload',
      description: 'Workload membership and status configuration.',
      uri: 'newrelic://workloads/{guid}',
      parametersSchema: z.object({ guid: guidSchema }).strict(),
      operation: WORKLOAD_GET,
      validateResult: requireResourceAtPath(['actor', 'entity'], 'Workload'),
      toolset: 'workloads',
    }),
    resource(context, {
      name: 'service_level',
      title: 'New Relic service level',
      description: 'Service-level indicator configuration by entity and indicator ID.',
      uri: 'newrelic://service-levels/{entityGuid}/{id}',
      parametersSchema: z
        .object({ entityGuid: guidSchema, id: z.string().min(1).max(512) })
        .strict(),
      operation: SERVICE_LEVEL_GET,
      validateResult: (data, parameters) => {
        requireResourceAtPath(['actor', 'entity'], 'Entity')(data, parameters);
        const indicators = valueAtPath(data, ['actor', 'entity', 'serviceLevel', 'indicators']);
        if (
          !Array.isArray(indicators) ||
          !indicators.some(
            (indicator) =>
              indicator !== null &&
              typeof indicator === 'object' &&
              String((indicator as Record<string, unknown>).id) === String(parameters.id),
          )
        ) {
          throw new CapabilityError('not_found', 'Service level was not found', {
            identifier: parameters.id,
          });
        }
      },
      mapResult: (data, { id }) => {
        if (!data || typeof data !== 'object') return data;
        const actor = (data as Record<string, unknown>).actor;
        const entity =
          actor && typeof actor === 'object'
            ? (actor as Record<string, unknown>).entity
            : undefined;
        const serviceLevel =
          entity && typeof entity === 'object'
            ? (entity as Record<string, unknown>).serviceLevel
            : undefined;
        const indicators =
          serviceLevel && typeof serviceLevel === 'object'
            ? (serviceLevel as Record<string, unknown>).indicators
            : undefined;
        if (!Array.isArray(indicators)) return data;
        return {
          ...(data as Record<string, unknown>),
          actor: {
            ...(actor as Record<string, unknown>),
            entity: {
              ...(entity as Record<string, unknown>),
              serviceLevel: {
                ...(serviceLevel as Record<string, unknown>),
                indicators: indicators.filter(
                  (indicator) =>
                    indicator &&
                    typeof indicator === 'object' &&
                    (indicator as Record<string, unknown>).id === id,
                ),
              },
            },
          },
        };
      },
      toolset: 'service-levels',
    }),
  ];

  const enabled = context.gates.enabledToolsets
    ? new Set(context.gates.enabledToolsets)
    : undefined;
  return definitions.filter(
    ({ toolset }) => toolset === undefined || enabled === undefined || enabled.has(toolset),
  );
}
