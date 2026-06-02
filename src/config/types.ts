import type { NewRelicRegion } from './endpoints.js';

export const TOOLSET_NAMES = [
  'core',
  'nrql',
  'entities',
  'alerts',
  'dashboards',
  'synthetics',
  'workloads',
  'service-levels',
  'logs',
  'metrics',
  'admin',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];
export type AuthMode = 'none' | 'bearer' | 'oidc';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export type NewRelicConfig = {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly region: NewRelicRegion;
  readonly defaultAccountId: number | undefined;
  readonly accountAllowlist: readonly number[];
};

export type FeatureGates = {
  readonly writes: boolean;
  readonly destructive: boolean;
  readonly admin: boolean;
  readonly previewApis: boolean;
  readonly experimentalAiIssues: boolean;
};

export type RuntimeLimits = {
  readonly concurrency: number;
  readonly nrqlConcurrency: number;
  readonly timeoutMs: number;
  readonly nrqlTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly cacheTtlMs: number;
  readonly cacheMaxEntries: number;
};

export type NoneAuthConfig = {
  readonly mode: 'none';
};

export type BearerAuthConfig = {
  readonly mode: 'bearer';
  readonly token: string;
};

export type OidcAuthConfig = {
  readonly mode: 'oidc';
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string | undefined;
  readonly algorithms: readonly string[];
  readonly resourceUrl: string;
};

export type HttpAuthConfig = NoneAuthConfig | BearerAuthConfig | OidcAuthConfig;

export type HttpConfig = {
  readonly host: string;
  readonly port: number;
  readonly auth: HttpAuthConfig;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly maxBodyBytes: number;
  readonly allowInsecureRemote: boolean;
  readonly exposeMetrics: boolean;
};

export type LoggingConfig = {
  readonly level: LogLevel;
};

export type TelemetryConfig = {
  readonly enabled: boolean;
  readonly serviceName: string;
};

export type AppConfig = {
  readonly newRelic: NewRelicConfig;
  readonly toolsets: readonly ToolsetName[];
  readonly gates: FeatureGates;
  readonly limits: RuntimeLimits;
  readonly http: HttpConfig;
  readonly logging: LoggingConfig;
  readonly telemetry: TelemetryConfig;
};

export type SafeAppConfig = Omit<AppConfig, 'newRelic' | 'http'> & {
  readonly newRelic: Omit<NewRelicConfig, 'apiKey'> & { readonly apiKeyConfigured: true };
  readonly http: Omit<HttpConfig, 'auth'> & {
    readonly auth:
      | NoneAuthConfig
      | { readonly mode: 'bearer'; readonly tokenConfigured: true }
      | (Omit<OidcAuthConfig, 'jwksUri'> & { readonly jwksUriConfigured: boolean });
  };
};
