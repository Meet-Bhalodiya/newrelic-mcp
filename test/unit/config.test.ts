import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  NERDGRAPH_ENDPOINTS,
  appConfigSchema,
  loadConfig,
  safeConfig,
} from '../../src/config/index.js';

const base = { NEW_RELIC_API_KEY: 'NRAK-test-value' } as const;

describe('configuration', () => {
  it('loads safe read-only defaults and the official US endpoint', () => {
    const config = loadConfig(base);
    expect(config.newRelic.endpoint).toBe(NERDGRAPH_ENDPOINTS.US);
    expect(config.gates).toEqual({
      writes: false,
      destructive: false,
      admin: false,
      previewApis: false,
      experimentalAiIssues: false,
    });
    expect(config.limits.concurrency).toBe(20);
    expect(config.limits.nrqlConcurrency).toBe(5);
    expect(config.limits.nrqlTimeoutMs).toBe(60_000);
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.http.auth.mode).toBe('none');
    expect(config.toolsets).not.toContain('admin');
  });

  it.each([
    ['US', 'https://api.newrelic.com/graphql'],
    ['EU', 'https://api.eu.newrelic.com/graphql'],
    ['JP', 'https://api.jp.newrelic.com/graphql'],
  ])('selects the official %s endpoint', (region, endpoint) => {
    expect(loadConfig({ ...base, NEW_RELIC_REGION: region }).newRelic.endpoint).toBe(endpoint);
  });

  it('requires exactly one API key source and reads a mounted secret', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...base, NEW_RELIC_API_KEY_FILE: '/secret' }, { readFile: () => 'ignored' }),
    ).toThrow(/exactly one/);
    const config = loadConfig(
      { NEW_RELIC_API_KEY_FILE: '/secret' },
      { readFile: (path) => (path === '/secret' ? ' mounted-key\n' : '') },
    );
    expect(config.newRelic.apiKey).toBe('mounted-key');
  });

  it('validates account isolation and limit relationships', () => {
    const config = loadConfig({
      ...base,
      NEW_RELIC_DEFAULT_ACCOUNT_ID: '42',
      NEW_RELIC_ACCOUNT_ALLOWLIST: '41,42,42',
    });
    expect(config.newRelic.accountAllowlist).toEqual([41, 42]);
    expect(() =>
      loadConfig({
        ...base,
        NEW_RELIC_DEFAULT_ACCOUNT_ID: '43',
        NEW_RELIC_ACCOUNT_ALLOWLIST: '42',
      }),
    ).toThrow(/must be in/);
    expect(() =>
      loadConfig({ ...base, NEW_RELIC_CONCURRENCY: '2', NEW_RELIC_NRQL_CONCURRENCY: '3' }),
    ).toThrow(/cannot exceed/);
  });

  it('validates the complete assembled configuration through one exported schema', () => {
    const config = loadConfig(base);
    expect(appConfigSchema.parse(config)).toEqual(config);
    expect(
      appConfigSchema.safeParse({
        ...config,
        newRelic: { ...config.newRelic, endpoint: NERDGRAPH_ENDPOINTS.EU },
      }).success,
    ).toBe(false);
    expect(
      appConfigSchema.safeParse({
        ...config,
        limits: { ...config.limits, concurrency: 2, nrqlConcurrency: 3 },
      }).success,
    ).toBe(false);
    expect(
      appConfigSchema.safeParse({
        ...config,
        gates: { ...config.gates, destructive: true },
      }).success,
    ).toBe(false);
  });

  it('accepts all toolsets and HTTP setting names from the public environment', () => {
    const config = loadConfig({
      ...base,
      NEW_RELIC_TOOLSETS: 'all',
      NEW_RELIC_CACHE_TTL_MS: '1234',
      NEW_RELIC_CACHE_MAX_ENTRIES: '12',
      MCP_HTTP_ALLOWED_HOSTS: 'mcp.example.test',
      MCP_HTTP_ALLOWED_ORIGINS: 'https://client.example.test',
    });
    expect(config.toolsets).toHaveLength(11);
    expect(config.limits.cacheTtlMs).toBe(1234);
    expect(config.limits.cacheMaxEntries).toBe(12);
    expect(config.http.allowedHosts).toEqual(['mcp.example.test']);
    expect(config.http.allowedOrigins).toEqual(['https://client.example.test']);
  });

  it('rejects safety gates whose prerequisites are disabled or out of scope', () => {
    expect(() => loadConfig({ ...base, NEW_RELIC_ENABLE_DESTRUCTIVE: 'true' })).toThrow(
      /requires NEW_RELIC_ENABLE_WRITES/u,
    );
    expect(() =>
      loadConfig({
        ...base,
        NEW_RELIC_ENABLE_WRITES: 'true',
        NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES: 'true',
        NEW_RELIC_TOOLSETS: 'core',
      }),
    ).toThrow(/requires the alerts toolset/u);
    expect(() =>
      loadConfig({ ...base, NEW_RELIC_ENABLE_ADMIN: 'true', NEW_RELIC_TOOLSETS: 'core' }),
    ).toThrow(/requires the admin toolset/u);
  });

  it('refuses unauthenticated non-loopback startup without break glass', () => {
    expect(() => loadConfig({ ...base, MCP_HTTP_HOST: '0.0.0.0' })).toThrow(/unauthenticated HTTP/);
    expect(
      loadConfig({
        ...base,
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_ALLOW_INSECURE_REMOTE: 'true',
      }).http.allowInsecureRemote,
    ).toBe(true);
  });

  it('loads bearer and OIDC modes without exposing their secrets', () => {
    const bearerToken = 'a'.repeat(32);
    const bearer = loadConfig({
      ...base,
      MCP_AUTH_MODE: 'bearer',
      MCP_BEARER_TOKEN: bearerToken,
    });
    expect(bearer.http.auth).toEqual({ mode: 'bearer', token: bearerToken });
    expect(JSON.stringify(safeConfig(bearer))).not.toContain(bearerToken);
    expect(() =>
      loadConfig({ ...base, MCP_AUTH_MODE: 'bearer', MCP_BEARER_TOKEN: 'too-short' }),
    ).toThrow(/32 to 8192 bytes/u);

    const oidc = loadConfig({
      ...base,
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_AUTH_MODE: 'oidc',
      MCP_OIDC_ISSUER: 'https://id.example.test/',
      MCP_OIDC_AUDIENCE: 'newrelic-mcp',
      MCP_OIDC_JWKS_URI: 'https://id.example.test/jwks',
      MCP_OIDC_RESOURCE_URL: 'https://mcp.example.test/mcp',
    });
    expect(oidc.http.auth).toMatchObject({
      mode: 'oidc',
      issuer: 'https://id.example.test/',
      audience: 'newrelic-mcp',
      resourceUrl: 'https://mcp.example.test/mcp',
    });
  });
});
