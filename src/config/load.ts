import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';
import { nerdGraphEndpoint } from './endpoints.js';
import {
  TOOLSET_NAMES,
  type AppConfig,
  type AuthMode,
  type HttpAuthConfig,
  type SafeAppConfig,
  type ToolsetName,
} from './types.js';

const ACCOUNT_ID_MAX = 2_147_483_647;
const DEFAULT_RESPONSE_LIMIT = 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

export type LoadConfigOptions = {
  readonly readFile?: (path: string) => string;
};

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function value(env: Environment, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === '' ? undefined : raw;
}

function booleanValue(env: Environment, name: string, fallback: boolean): boolean {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new ConfigurationError([`${name} must be a boolean`]);
}

function integerValue(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError([`${name} must be an integer between ${minimum} and ${maximum}`]);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError([`${name} must be an integer between ${minimum} and ${maximum}`]);
  }
  return parsed;
}

function optionalAccountId(env: Environment, name: string): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return undefined;
  return integerValue(env, name, 1, 1, ACCOUNT_ID_MAX);
}

function csv(env: Environment, name: string): string[] {
  const raw = value(env, name);
  if (raw === undefined) return [];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)];
}

function accountAllowlist(env: Environment): number[] {
  return csv(env, 'NEW_RELIC_ACCOUNT_ALLOWLIST').map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw new ConfigurationError([
        'NEW_RELIC_ACCOUNT_ALLOWLIST must contain positive account IDs',
      ]);
    }
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ACCOUNT_ID_MAX) {
      throw new ConfigurationError([
        'NEW_RELIC_ACCOUNT_ALLOWLIST must contain valid GraphQL Int account IDs',
      ]);
    }
    return parsed;
  });
}

function secret(
  env: Environment,
  directName: string,
  fileName: string,
  readFile: (path: string) => string,
): string {
  const direct = value(env, directName);
  const file = value(env, fileName);
  if ((direct === undefined) === (file === undefined)) {
    throw new ConfigurationError([`exactly one of ${directName} or ${fileName} must be set`]);
  }

  let resolved: string;
  if (direct !== undefined) {
    resolved = direct;
  } else {
    try {
      resolved = readFile(file ?? '').trim();
    } catch {
      throw new ConfigurationError([`${fileName} could not be read`]);
    }
  }
  if (resolved.trim() === '') {
    throw new ConfigurationError([`${directName}/${fileName} must not be empty`]);
  }
  if (resolved.includes('\0') || /[\r\n]/.test(resolved.trim())) {
    throw new ConfigurationError([`${directName}/${fileName} must contain a single-line secret`]);
  }
  return resolved.trim();
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '') throw new ConfigurationError(['MCP_HTTP_HOST must not be empty']);
  if (trimmed.includes('/') || trimmed.includes('@') || trimmed.includes('\0')) {
    throw new ConfigurationError(['MCP_HTTP_HOST must be a hostname or IP address']);
  }
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith('127.');
  if (ipVersion === 6) return normalized === '::1';
  return false;
}

function toolsets(env: Environment): ToolsetName[] {
  const configured = csv(env, 'NEW_RELIC_TOOLSETS');
  if (configured.length === 0) return TOOLSET_NAMES.filter((name) => name !== 'admin');
  if (configured.length === 1 && configured[0]?.toLowerCase() === 'all') return [...TOOLSET_NAMES];
  const schema = z.array(z.enum(TOOLSET_NAMES));
  const result = schema.safeParse(configured);
  if (!result.success) {
    throw new ConfigurationError([
      `NEW_RELIC_TOOLSETS must contain only: ${TOOLSET_NAMES.join(', ')}`,
    ]);
  }
  return result.data;
}

function absoluteUrl(raw: string, name: string, allowedProtocols = ['https:']): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError([`${name} must be an absolute URL`]);
  }
  if (!allowedProtocols.includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new ConfigurationError([
      `${name} must use ${allowedProtocols.join(' or ')} without user info`,
    ]);
  }
  url.hash = '';
  return url.toString();
}

function authConfig(
  env: Environment,
  host: string,
  port: number,
  readFile: (path: string) => string,
): HttpAuthConfig {
  const modeRaw = value(env, 'MCP_AUTH_MODE')?.toLowerCase() ?? 'none';
  const modeResult = z.enum(['none', 'bearer', 'oidc']).safeParse(modeRaw);
  if (!modeResult.success) {
    throw new ConfigurationError(['MCP_AUTH_MODE must be none, bearer, or oidc']);
  }
  const mode: AuthMode = modeResult.data;
  if (mode === 'none') return { mode };
  if (mode === 'bearer') {
    const token = secret(env, 'MCP_BEARER_TOKEN', 'MCP_BEARER_TOKEN_FILE', readFile);
    if (Buffer.byteLength(token, 'utf8') < 32 || Buffer.byteLength(token, 'utf8') > 8192) {
      throw new ConfigurationError([
        'MCP_BEARER_TOKEN/MCP_BEARER_TOKEN_FILE must contain 32 to 8192 bytes',
      ]);
    }
    return {
      mode,
      token,
    };
  }

  const issuerRaw = value(env, 'MCP_OIDC_ISSUER');
  const audience = value(env, 'MCP_OIDC_AUDIENCE');
  if (issuerRaw === undefined || audience === undefined) {
    throw new ConfigurationError([
      'MCP_OIDC_ISSUER and MCP_OIDC_AUDIENCE are required in oidc mode',
    ]);
  }
  const issuer = absoluteUrl(issuerRaw, 'MCP_OIDC_ISSUER');
  const jwksRaw = value(env, 'MCP_OIDC_JWKS_URI');
  const resourceDefault = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`;
  const resourceRaw =
    value(env, 'MCP_OIDC_RESOURCE_URL') ?? value(env, 'MCP_RESOURCE_URL') ?? resourceDefault;
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resourceRaw);
  } catch {
    throw new ConfigurationError(['MCP_OIDC_RESOURCE_URL must be an absolute URL']);
  }
  const resourceProtocols = isLoopbackHost(resourceUrl.hostname) ? ['https:', 'http:'] : ['https:'];
  const algorithms = csv(env, 'MCP_OIDC_ALGORITHMS');
  const effectiveAlgorithms = algorithms.length === 0 ? ['RS256', 'ES256'] : algorithms;
  const unsafeAlgorithm = effectiveAlgorithms.find(
    (algorithm) => !/^(?:RS|PS|ES)(?:256|384|512)$/.test(algorithm),
  );
  if (unsafeAlgorithm !== undefined) {
    throw new ConfigurationError([
      'MCP_OIDC_ALGORITHMS supports asymmetric RS, PS, or ES algorithms only',
    ]);
  }
  return {
    mode,
    issuer,
    audience,
    jwksUri: jwksRaw === undefined ? undefined : absoluteUrl(jwksRaw, 'MCP_OIDC_JWKS_URI'),
    algorithms: effectiveAlgorithms,
    resourceUrl: absoluteUrl(resourceRaw, 'MCP_RESOURCE_URL', resourceProtocols),
  };
}

function originList(env: Environment): string[] {
  const configured =
    value(env, 'MCP_HTTP_ALLOWED_ORIGINS') === undefined
      ? csv(env, 'MCP_ALLOWED_ORIGINS')
      : csv(env, 'MCP_HTTP_ALLOWED_ORIGINS');
  return configured.map((origin) => {
    const parsed = absoluteUrl(origin, 'MCP_ALLOWED_ORIGINS', ['https:', 'http:']);
    const url = new URL(parsed);
    if (url.pathname !== '/' && url.pathname !== '') {
      throw new ConfigurationError(['MCP_ALLOWED_ORIGINS entries must not include a path']);
    }
    return url.origin;
  });
}

function hostList(env: Environment, bindHost: string): string[] {
  const configured =
    value(env, 'MCP_HTTP_ALLOWED_HOSTS') === undefined
      ? csv(env, 'MCP_ALLOWED_HOSTS')
      : csv(env, 'MCP_HTTP_ALLOWED_HOSTS');
  const hosts =
    configured.length === 0 ? [bindHost, 'localhost', '127.0.0.1', '[::1]'] : configured;
  return [...new Set(hosts.map((host) => host.toLowerCase()))];
}

const accountIdSchema = z.number().int().min(1).max(ACCOUNT_ID_MAX);
const hostSchema = z
  .string()
  .min(1)
  .superRefine((host, context) => {
    try {
      normalizeHost(host);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a hostname or IP address' });
    }
  });
const absoluteHttpUrlSchema = z.string().superRefine((raw, context) => {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      context.addIssue({
        code: 'custom',
        message: 'must be an absolute HTTP(S) URL without user info',
      });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'must be an absolute HTTP(S) URL' });
  }
});
const absoluteHttpsUrlSchema = absoluteHttpUrlSchema.refine((raw) => {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must use HTTPS');
const bearerTokenSchema = z.string().superRefine((token, context) => {
  const length = Buffer.byteLength(token, 'utf8');
  if (length < 32 || length > 8192) {
    context.addIssue({ code: 'custom', message: 'must contain 32 to 8192 bytes' });
  }
});
const oidcAlgorithmSchema = z
  .string()
  .regex(/^(?:RS|PS|ES)(?:256|384|512)$/u, 'must be an asymmetric RS, PS, or ES algorithm');
const authSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('bearer'), token: bearerTokenSchema }).strict(),
  z
    .object({
      mode: z.literal('oidc'),
      issuer: absoluteHttpsUrlSchema,
      audience: z.string().min(1),
      jwksUri: z.union([absoluteHttpsUrlSchema, z.undefined()]),
      algorithms: z.array(oidcAlgorithmSchema).min(1),
      resourceUrl: absoluteHttpUrlSchema,
    })
    .strict(),
]);

/**
 * The authoritative, typed boundary for the fully assembled public runtime
 * configuration. Environment parsing and secret-file resolution happen first;
 * no configuration leaves `loadConfig` until this complete schema accepts it.
 */
export const appConfigSchema: z.ZodType<AppConfig> = z
  .object({
    newRelic: z
      .object({
        apiKey: z
          .string()
          .min(1)
          .refine((key) => !key.includes('\0') && !/[\r\n]/u.test(key), 'must be one line'),
        region: z.enum(['US', 'EU', 'JP']),
        endpoint: absoluteHttpsUrlSchema,
        defaultAccountId: z.union([accountIdSchema, z.undefined()]),
        accountAllowlist: z.array(accountIdSchema),
      })
      .strict(),
    toolsets: z
      .array(z.enum(TOOLSET_NAMES))
      .min(1)
      .refine((names) => new Set(names).size === names.length, 'toolsets must be unique'),
    gates: z
      .object({
        writes: z.boolean(),
        destructive: z.boolean(),
        admin: z.boolean(),
        previewApis: z.boolean(),
        experimentalAiIssues: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(24),
        nrqlConcurrency: z.number().int().min(1).max(5),
        timeoutMs: z.number().int().min(100).max(600_000),
        nrqlTimeoutMs: z.number().int().min(100).max(600_000),
        maxResponseBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024),
        cacheTtlMs: z.number().int().min(0).max(3_600_000),
        cacheMaxEntries: z.number().int().min(0).max(10_000),
      })
      .strict(),
    http: z
      .object({
        host: hostSchema,
        port: z.number().int().min(1).max(65_535),
        auth: authSchema,
        allowedOrigins: z.array(absoluteHttpUrlSchema),
        allowedHosts: z.array(z.string().min(1)).min(1),
        maxBodyBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024),
        allowInsecureRemote: z.boolean(),
        exposeMetrics: z.boolean(),
      })
      .strict(),
    logging: z
      .object({
        level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
      })
      .strict(),
    telemetry: z.object({ enabled: z.boolean(), serviceName: z.string().min(1) }).strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const issue = (message: string, path: readonly (string | number)[]): void => {
      context.addIssue({ code: 'custom', message, path: [...path] });
    };

    if (config.newRelic.endpoint !== nerdGraphEndpoint(config.newRelic.region)) {
      issue('New Relic endpoint must match NEW_RELIC_REGION', ['newRelic', 'endpoint']);
    }
    if (
      config.newRelic.defaultAccountId !== undefined &&
      config.newRelic.accountAllowlist.length > 0 &&
      !config.newRelic.accountAllowlist.includes(config.newRelic.defaultAccountId)
    ) {
      issue('NEW_RELIC_DEFAULT_ACCOUNT_ID must be in NEW_RELIC_ACCOUNT_ALLOWLIST', [
        'newRelic',
        'defaultAccountId',
      ]);
    }
    if (config.limits.nrqlConcurrency > config.limits.concurrency) {
      issue('NEW_RELIC_NRQL_CONCURRENCY cannot exceed NEW_RELIC_CONCURRENCY', [
        'limits',
        'nrqlConcurrency',
      ]);
    }
    let httpHostIsLoopback = false;
    try {
      httpHostIsLoopback = isLoopbackHost(config.http.host);
    } catch {
      // The host schema reports the actionable issue.
    }
    if (
      config.http.auth.mode === 'none' &&
      !httpHostIsLoopback &&
      !config.http.allowInsecureRemote
    ) {
      issue(
        'unauthenticated HTTP may bind only to loopback; configure auth or MCP_ALLOW_INSECURE_REMOTE=true',
        ['http', 'auth'],
      );
    }
    if (config.http.auth.mode === 'oidc') {
      try {
        const resource = new URL(config.http.auth.resourceUrl);
        if (resource.protocol !== 'https:' && !isLoopbackHost(resource.hostname)) {
          issue('MCP_RESOURCE_URL must use HTTPS unless it targets loopback', [
            'http',
            'auth',
            'resourceUrl',
          ]);
        }
      } catch {
        // The URL schema reports malformed values.
      }
    }
    if (config.gates.destructive && !config.gates.writes) {
      issue('NEW_RELIC_ENABLE_DESTRUCTIVE requires NEW_RELIC_ENABLE_WRITES', [
        'gates',
        'destructive',
      ]);
    }
    if (config.gates.previewApis && !config.gates.writes) {
      issue('NEW_RELIC_ENABLE_PREVIEW_APIS requires NEW_RELIC_ENABLE_WRITES', [
        'gates',
        'previewApis',
      ]);
    }
    if (config.gates.experimentalAiIssues && !config.gates.writes) {
      issue('NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES requires NEW_RELIC_ENABLE_WRITES', [
        'gates',
        'experimentalAiIssues',
      ]);
    }
    if (config.gates.experimentalAiIssues && !config.toolsets.includes('alerts')) {
      issue('NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES requires the alerts toolset', [
        'gates',
        'experimentalAiIssues',
      ]);
    }
    if (config.gates.previewApis && !config.toolsets.includes('metrics')) {
      issue('NEW_RELIC_ENABLE_PREVIEW_APIS requires the metrics toolset', ['gates', 'previewApis']);
    }
    if (config.gates.admin && !config.toolsets.includes('admin')) {
      issue('NEW_RELIC_ENABLE_ADMIN requires the admin toolset', ['gates', 'admin']);
    }
  });

function validateAssembledConfig(candidate: unknown): AppConfig {
  const result = appConfigSchema.safeParse(candidate);
  if (result.success) return result.data;
  throw new ConfigurationError(result.error.issues.map(({ message }) => message));
}

export function loadConfig(
  env: Environment = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const apiKey = secret(env, 'NEW_RELIC_API_KEY', 'NEW_RELIC_API_KEY_FILE', readFile);
  const regionResult = z
    .enum(['US', 'EU', 'JP'])
    .safeParse((value(env, 'NEW_RELIC_REGION') ?? 'US').toUpperCase());
  if (!regionResult.success) {
    throw new ConfigurationError(['NEW_RELIC_REGION must be US, EU, or JP']);
  }
  const defaultAccountId = optionalAccountId(env, 'NEW_RELIC_DEFAULT_ACCOUNT_ID');
  const allowlist = accountAllowlist(env);
  const concurrency = integerValue(env, 'NEW_RELIC_CONCURRENCY', 20, 1, 24);
  const nrqlConcurrency = integerValue(env, 'NEW_RELIC_NRQL_CONCURRENCY', 5, 1, 5);

  const host = normalizeHost(value(env, 'MCP_HTTP_HOST') ?? '127.0.0.1');
  const port = integerValue(env, 'MCP_HTTP_PORT', 3000, 1, 65_535);
  const allowInsecureRemote = booleanValue(env, 'MCP_ALLOW_INSECURE_REMOTE', false);
  const auth = authConfig(env, host, port, readFile);

  const logLevelRaw = value(env, 'LOG_LEVEL')?.toLowerCase() ?? 'info';
  const logLevelResult = z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .safeParse(logLevelRaw);
  if (!logLevelResult.success) {
    throw new ConfigurationError(['LOG_LEVEL is invalid']);
  }

  const selectedToolsets = toolsets(env);
  const gates = {
    writes: booleanValue(env, 'NEW_RELIC_ENABLE_WRITES', false),
    destructive: booleanValue(env, 'NEW_RELIC_ENABLE_DESTRUCTIVE', false),
    admin: booleanValue(env, 'NEW_RELIC_ENABLE_ADMIN', false),
    previewApis: booleanValue(env, 'NEW_RELIC_ENABLE_PREVIEW_APIS', false),
    experimentalAiIssues: booleanValue(env, 'NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES', false),
  };
  return validateAssembledConfig({
    newRelic: {
      apiKey,
      region: regionResult.data,
      endpoint: nerdGraphEndpoint(regionResult.data),
      defaultAccountId,
      accountAllowlist: allowlist,
    },
    toolsets: selectedToolsets,
    gates,
    limits: {
      concurrency,
      nrqlConcurrency,
      timeoutMs: integerValue(env, 'NEW_RELIC_TIMEOUT_MS', 30_000, 100, 600_000),
      nrqlTimeoutMs: integerValue(env, 'NEW_RELIC_NRQL_TIMEOUT_MS', 60_000, 100, 600_000),
      maxResponseBytes: integerValue(
        env,
        'NEW_RELIC_MAX_RESPONSE_BYTES',
        DEFAULT_RESPONSE_LIMIT,
        1024,
        16 * 1024 * 1024,
      ),
      cacheTtlMs: integerValue(env, 'NEW_RELIC_CACHE_TTL_MS', 0, 0, 3_600_000),
      cacheMaxEntries: integerValue(env, 'NEW_RELIC_CACHE_MAX_ENTRIES', 500, 0, 10_000),
    },
    http: {
      host,
      port,
      auth,
      allowedOrigins: originList(env),
      allowedHosts: hostList(env, host),
      maxBodyBytes: integerValue(
        env,
        'MCP_HTTP_MAX_BODY_BYTES',
        1024 * 1024,
        1024,
        16 * 1024 * 1024,
      ),
      allowInsecureRemote,
      exposeMetrics: booleanValue(env, 'MCP_METRICS_ENABLED', false),
    },
    logging: { level: logLevelResult.data },
    telemetry: {
      enabled: booleanValue(env, 'MCP_TELEMETRY_ENABLED', false),
      serviceName: value(env, 'OTEL_SERVICE_NAME') ?? 'newrelic-mcp',
    },
  });
}

export function safeConfig(config: AppConfig): SafeAppConfig {
  const auth = config.http.auth;
  const safeAuth: SafeAppConfig['http']['auth'] =
    auth.mode === 'bearer'
      ? { mode: 'bearer', tokenConfigured: true }
      : auth.mode === 'oidc'
        ? {
            mode: 'oidc',
            issuer: auth.issuer,
            audience: auth.audience,
            algorithms: auth.algorithms,
            resourceUrl: auth.resourceUrl,
            jwksUriConfigured: auth.jwksUri !== undefined,
          }
        : { mode: 'none' };
  return {
    newRelic: {
      endpoint: config.newRelic.endpoint,
      region: config.newRelic.region,
      defaultAccountId: config.newRelic.defaultAccountId,
      accountAllowlist: config.newRelic.accountAllowlist,
      apiKeyConfigured: true,
    },
    toolsets: config.toolsets,
    gates: config.gates,
    limits: config.limits,
    http: {
      host: config.http.host,
      port: config.http.port,
      allowedOrigins: config.http.allowedOrigins,
      allowedHosts: config.http.allowedHosts,
      maxBodyBytes: config.http.maxBodyBytes,
      allowInsecureRemote: config.http.allowInsecureRemote,
      exposeMetrics: config.http.exposeMetrics,
      auth: safeAuth,
    },
    logging: config.logging,
    telemetry: config.telemetry,
  };
}
