import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { OidcAuthConfig } from '../config/types.js';
import { AuthenticationError, AuthorizationError } from './errors.js';
import { extractBearerToken } from './bearer.js';

export const NEW_RELIC_MCP_SCOPES = ['newrelic:read', 'newrelic:write', 'newrelic:admin'] as const;

export type NewRelicMcpScope = (typeof NEW_RELIC_MCP_SCOPES)[number];

export type AuthPrincipal = {
  readonly subject: string;
  readonly issuer: string | undefined;
  readonly audience: readonly string[];
  readonly scopes: ReadonlySet<string>;
  readonly clientId: string | undefined;
};

export type OidcVerifierOptions = {
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly jwksUri?: string | undefined;
  readonly algorithms?: readonly string[] | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly keyResolver?: JWTVerifyGetKey | undefined;
  readonly clockToleranceSeconds?: number | undefined;
  readonly discoveryTimeoutMs?: number | undefined;
};

export type OidcVerifier = {
  verifyAuthorization(
    authorization: string | undefined,
    requiredScopes?: readonly string[],
  ): Promise<AuthPrincipal>;
  verifyToken(token: string, requiredScopes?: readonly string[]): Promise<AuthPrincipal>;
};

type DiscoveryDocument = {
  readonly issuer: string;
  readonly jwks_uri: string;
};

function boundedOidcFetch(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, { ...init, redirect: 'error' });
    const maximumBytes = 256 * 1024;
    const advertisedLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
      await response.body?.cancel();
      throw new AuthenticationError('OIDC metadata response is too large');
    }
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        continue;
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new AuthenticationError('OIDC metadata response is too large');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function discoveryUrl(issuer: string): URL {
  const url = new URL(issuer);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`;
  url.search = '';
  url.hash = '';
  return url;
}

async function discover(options: OidcVerifierOptions): Promise<DiscoveryDocument> {
  const fetchImplementation = boundedOidcFetch(options.fetch ?? globalThis.fetch);
  const timeout = AbortSignal.timeout(options.discoveryTimeoutMs ?? 5_000);
  let response: Response;
  try {
    response = await fetchImplementation(discoveryUrl(options.issuer), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeout,
    });
  } catch (error) {
    throw new AuthenticationError('OIDC discovery failed', { cause: error });
  }
  if (!response.ok) throw new AuthenticationError('OIDC discovery failed');
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > 64 * 1024) {
    throw new AuthenticationError('OIDC discovery response is too large');
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
    throw new AuthenticationError('OIDC discovery response is too large');
  }
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new AuthenticationError('OIDC discovery returned invalid JSON');
  }
  if (document === null || typeof document !== 'object') {
    throw new AuthenticationError('OIDC discovery returned invalid metadata');
  }
  const candidate = document as Record<string, unknown>;
  if (candidate.issuer !== options.issuer || typeof candidate.jwks_uri !== 'string') {
    throw new AuthenticationError('OIDC discovery metadata does not match the configured issuer');
  }
  const jwks = new URL(candidate.jwks_uri);
  if (jwks.protocol !== 'https:' || jwks.username !== '' || jwks.password !== '') {
    throw new AuthenticationError('OIDC JWKS URI must be an HTTPS URL without user info');
  }
  return { issuer: candidate.issuer, jwks_uri: jwks.toString() };
}

export function tokenScopes(payload: JWTPayload): ReadonlySet<string> {
  const values: string[] = [];
  if (typeof payload.scope === 'string') values.push(...payload.scope.split(/\s+/));
  const scp = payload.scp;
  if (typeof scp === 'string') values.push(...scp.split(/\s+/));
  if (Array.isArray(scp)) {
    values.push(...scp.filter((scope): scope is string => typeof scope === 'string'));
  }
  return new Set(values.filter(Boolean));
}

export function requireScopes(scopes: ReadonlySet<string>, required: readonly string[]): void {
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length > 0)
    throw new AuthorizationError('Bearer token lacks required scope', missing);
}

export async function createOidcVerifier(options: OidcVerifierOptions): Promise<OidcVerifier> {
  const algorithms = [...(options.algorithms ?? ['RS256', 'ES256'])];
  if (
    algorithms.length === 0 ||
    algorithms.some((algorithm) => !/^(?:RS|PS|ES)(?:256|384|512)$/.test(algorithm))
  ) {
    throw new AuthenticationError(
      'OIDC verifier requires an asymmetric signing algorithm allowlist',
    );
  }
  let resolver = options.keyResolver;
  if (resolver === undefined) {
    const jwksUri = options.jwksUri ?? (await discover(options)).jwks_uri;
    const url = new URL(jwksUri);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new AuthenticationError('OIDC JWKS URI must be an HTTPS URL without user info');
    }
    resolver = createRemoteJWKSet(url, {
      [customFetch]: boundedOidcFetch(options.fetch ?? globalThis.fetch),
      timeoutDuration: options.discoveryTimeoutMs ?? 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }
  const keyResolver: JWTVerifyGetKey = resolver;
  const audiences: string | string[] =
    typeof options.audience === 'string' ? options.audience : [...options.audience];

  async function verifyToken(
    token: string,
    requiredScopes: readonly string[] = [],
  ): Promise<AuthPrincipal> {
    if (token.length === 0 || token.length > 16_384)
      throw new AuthenticationError('Invalid bearer token');
    try {
      const { payload } = await jwtVerify(token, keyResolver, {
        issuer: options.issuer,
        audience: audiences,
        algorithms,
        clockTolerance: options.clockToleranceSeconds ?? 5,
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('missing subject');
      const scopes = tokenScopes(payload);
      requireScopes(scopes, requiredScopes);
      const audience = Array.isArray(payload.aud)
        ? payload.aud
        : payload.aud === undefined
          ? []
          : [payload.aud];
      const clientId =
        typeof payload.client_id === 'string'
          ? payload.client_id
          : typeof payload.azp === 'string'
            ? payload.azp
            : undefined;
      return {
        subject: payload.sub,
        issuer: payload.iss,
        audience,
        scopes,
        clientId,
      };
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new AuthenticationError('Invalid or expired bearer token', { cause: error });
    }
  }

  return {
    verifyToken,
    verifyAuthorization: async (authorization, requiredScopes = []) =>
      verifyToken(extractBearerToken(authorization), requiredScopes),
  };
}

export async function createConfiguredOidcVerifier(config: OidcAuthConfig): Promise<OidcVerifier> {
  return createOidcVerifier({
    issuer: config.issuer,
    audience: config.audience,
    jwksUri: config.jwksUri,
    algorithms: config.algorithms,
  });
}

export type ProtectedResourceMetadata = {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ['header'];
  readonly resource_name: string;
};

export function protectedResourceMetadata(
  resourceUrl: string,
  issuer: string,
): ProtectedResourceMetadata {
  return {
    resource: resourceUrl,
    authorization_servers: [issuer],
    scopes_supported: NEW_RELIC_MCP_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'New Relic MCP Server',
  };
}

export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  const resourcePath = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function quoteWwwAuthenticate(value: string): string {
  return value.replace(/["\\\r\n]/g, '');
}

export function wwwAuthenticateHeader(
  resourceUrl: string,
  options: {
    readonly error?: string;
    readonly description?: string;
    readonly scope?: readonly string[];
  } = {},
): string {
  const fields = [
    `resource_metadata="${quoteWwwAuthenticate(protectedResourceMetadataUrl(resourceUrl))}"`,
  ];
  if (options.error !== undefined) fields.push(`error="${quoteWwwAuthenticate(options.error)}"`);
  if (options.description !== undefined) {
    fields.push(`error_description="${quoteWwwAuthenticate(options.description)}"`);
  }
  if (options.scope !== undefined && options.scope.length > 0) {
    fields.push(`scope="${quoteWwwAuthenticate(options.scope.join(' '))}"`);
  }
  return `Bearer ${fields.join(', ')}`;
}
