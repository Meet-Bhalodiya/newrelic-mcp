import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import express, { type NextFunction, type Request, type Response } from 'express';

import type { Runtime } from './runtime.js';
import type { McpRequestSignalContext } from './server.js';
import {
  TOOL_CATALOG,
  areSpecGatesEnabled,
  isToolsetEnabled,
  type CapabilityGates,
} from './toolsets/index.js';
import {
  AuthenticationError,
  AuthorizationError,
  assertAllowedHost,
  assertAllowedOrigin,
  createAuthenticator,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticateHeader,
} from './security/index.js';

export type McpServerFactory = (requestContext?: McpRequestSignalContext) => McpServer;

type JsonRpcRequestId = string | number;

type InFlightEntry = {
  readonly controller: AbortController;
  readonly expires: NodeJS.Timeout;
};

type InFlightRegistration = {
  readonly requestContext: McpRequestSignalContext;
  close(abort: boolean): void;
};

class InFlightRequestRegistry {
  readonly #entries = new Map<string, InFlightEntry>();
  readonly #maximumEntries: number;
  readonly #maximumLifetimeMs: number;

  constructor(maximumEntries: number, maximumLifetimeMs: number) {
    this.#maximumEntries = maximumEntries;
    this.#maximumLifetimeMs = maximumLifetimeMs;
  }

  register(principal: string, requestIds: readonly JsonRpcRequestId[]): InFlightRegistration {
    const keys = requestIds.map((requestId) => registryKey(principal, requestId));
    if (new Set(keys).size !== keys.length || keys.some((key) => this.#entries.has(key))) {
      throw new InFlightCollisionError();
    }
    if (this.#entries.size + keys.length > this.#maximumEntries) {
      throw new InFlightCapacityError();
    }

    const ownedEntries = new Map<string, InFlightEntry>();
    for (const key of keys) {
      const controller = new AbortController();
      const expires = setTimeout(() => {
        const entry = this.#entries.get(key);
        if (entry?.controller !== controller) return;
        this.#entries.delete(key);
        controller.abort(new DOMException('MCP request lifetime exceeded', 'TimeoutError'));
      }, this.#maximumLifetimeMs);
      expires.unref();
      const entry = { controller, expires };
      this.#entries.set(key, entry);
      ownedEntries.set(key, entry);
    }

    let closed = false;
    return {
      requestContext: {
        signalForRequest: (requestId, sdkSignal) => {
          const entry = ownedEntries.get(registryKey(principal, requestId));
          return entry === undefined
            ? sdkSignal
            : AbortSignal.any([sdkSignal, entry.controller.signal]);
        },
      },
      close: (abort) => {
        if (closed) return;
        closed = true;
        for (const [key, entry] of ownedEntries) {
          clearTimeout(entry.expires);
          if (this.#entries.get(key)?.controller === entry.controller) {
            this.#entries.delete(key);
          }
          if (abort && !entry.controller.signal.aborted) {
            entry.controller.abort(new DOMException('MCP HTTP request closed', 'AbortError'));
          }
        }
      },
    };
  }

  cancel(principal: string, requestId: JsonRpcRequestId): void {
    const entry = this.#entries.get(registryKey(principal, requestId));
    if (entry !== undefined && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException('MCP client cancelled the request', 'AbortError'));
    }
  }
}

class InFlightCollisionError extends Error {}
class InFlightCapacityError extends Error {}

export async function createHttpApp(runtime: Runtime, createServerInstance: McpServerFactory) {
  const { config } = runtime;
  const authenticator = await createAuthenticator(config.http.auth);
  const inFlight = new InFlightRequestRegistry(
    Math.max(64, config.limits.concurrency * 50),
    Math.max(config.limits.timeoutMs, config.limits.nrqlTimeoutMs) * 3 + 5_000,
  );
  const app = express();
  app.disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    try {
      assertAllowedHost(request.headers.host, config.http.allowedHosts);
      assertAllowedOrigin(request.headers.origin, config.http.allowedOrigins);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    } catch {
      response.status(403).json({ error: 'request_origin_not_allowed' });
    }
  });
  app.use('/mcp', (request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'POST') {
      next();
      return;
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=(?:"?utf-8"?))?\s*$/iu.test(contentType)
    ) {
      response.setHeader('Connection', 'close');
      response.status(415).json({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Content-Type must be application/json.' },
        id: null,
      });
      return;
    }
    next();
  });
  app.use(
    express.json({ limit: config.http.maxBodyBytes, strict: true, type: 'application/json' }),
  );

  if (config.http.auth.mode === 'oidc') {
    const oidcAuth = config.http.auth;
    const metadataUrl = new URL(protectedResourceMetadataUrl(oidcAuth.resourceUrl));
    app.get(metadataUrl.pathname, (_request, response) => {
      response.json(protectedResourceMetadata(oidcAuth.resourceUrl, oidcAuth.issuer));
    });
  }

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.get('/readyz', (_request, response) => {
    response.json({ status: 'ready', region: config.newRelic.region });
  });

  const authenticate = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const requiredScopes = requiredScopesForRequest(request.body, runtime);
    try {
      const authorization = request.headers.authorization;
      const principal = await authenticator(
        authorization,
        config.http.auth.mode === 'oidc' ? requiredScopes : [],
      );
      (request as Request & { auth?: AuthInfo }).auth = {
        // AuthInfo requires a token-shaped marker, but downstream code only needs the
        // verified identity and scopes. Never retain the caller's bearer credential.
        token: authorization === undefined ? '[local]' : '[verified]',
        clientId: principal.clientId ?? principal.subject,
        scopes: [...principal.scopes],
        ...(config.http.auth.mode === 'oidc'
          ? { resource: new URL(config.http.auth.resourceUrl) }
          : {}),
        extra: { subject: principal.subject, issuer: principal.issuer },
      };
      next();
    } catch (error) {
      const isAuthorization = error instanceof AuthorizationError;
      const status = isAuthorization ? 403 : 401;
      if (config.http.auth.mode === 'oidc') {
        response.setHeader(
          'WWW-Authenticate',
          wwwAuthenticateHeader(config.http.auth.resourceUrl, {
            error: isAuthorization ? 'insufficient_scope' : 'invalid_token',
            description: isAuthorization ? 'Required scope is missing' : 'Authentication required',
            scope: isAuthorization ? error.requiredScopes : requiredScopes,
          }),
        );
      } else {
        response.setHeader('WWW-Authenticate', 'Bearer');
      }
      response
        .status(status)
        .json({ error: isAuthorization ? 'insufficient_scope' : 'unauthorized' });
    }
  };

  app.post('/mcp', authenticate, async (request, response) => {
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    let registration: InFlightRegistration | undefined;
    const principal = authenticatedPrincipalKey(request);
    for (const cancellation of cancellationNotifications(request.body)) {
      inFlight.cancel(principal, cancellation);
    }
    const cleanup = (): void => {
      registration?.close(true);
      if (transport !== undefined) void transport.close();
      if (server !== undefined) void server.close();
    };
    response.once('close', cleanup);
    request.once('aborted', cleanup);
    try {
      registration = inFlight.register(principal, jsonRpcRequestIds(request.body));
      server = createServerInstance(registration.requestContext);
      transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK 1.29's declaration does not model exactOptionalPropertyTypes on Transport callbacks.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (error instanceof InFlightCollisionError || error instanceof InFlightCapacityError) {
        if (!response.headersSent) {
          response.status(error instanceof InFlightCollisionError ? 409 : 503).json({
            jsonrpc: '2.0',
            error: {
              code: error instanceof InFlightCollisionError ? -32_600 : -32_002,
              message:
                error instanceof InFlightCollisionError
                  ? 'A request with this JSON-RPC ID is already in flight.'
                  : 'The in-flight request limit has been reached.',
            },
            id: null,
          });
        }
        return;
      }
      runtime.observability.logger.error(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'MCP HTTP request failed',
      );
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Method not allowed in stateless HTTP mode.' },
      id: null,
    });
  };
  app.get('/mcp', authenticate, methodNotAllowed);
  app.delete('/mcp', authenticate, methodNotAllowed);

  if (config.http.exposeMetrics) {
    app.get('/metrics', authenticate, async (_request, response) => {
      response.type(runtime.observability.registry.contentType);
      response.send(await runtime.observability.registry.metrics());
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    const bodyTooLarge =
      error !== null &&
      typeof error === 'object' &&
      'type' in error &&
      (error as { type?: unknown }).type === 'entity.too.large';
    const invalidJson =
      error !== null &&
      typeof error === 'object' &&
      'type' in error &&
      (error as { type?: unknown }).type === 'entity.parse.failed';
    if (!bodyTooLarge && !invalidJson) {
      runtime.observability.logger.error(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Unhandled HTTP request error',
      );
    }
    response.status(bodyTooLarge ? 413 : invalidJson ? 400 : 500).json({
      jsonrpc: '2.0',
      error: {
        code: bodyTooLarge ? -32_001 : invalidJson ? -32_700 : -32_603,
        message: bodyTooLarge
          ? 'Request body is too large.'
          : invalidJson
            ? 'Invalid JSON request body.'
            : 'Internal server error',
      },
      id: null,
    });
  });

  return app;
}

function authenticatedPrincipalKey(request: Request): string {
  const auth = (request as Request & { auth?: AuthInfo }).auth;
  const extra = auth?.extra;
  const subject =
    extra !== undefined && typeof extra.subject === 'string' ? extra.subject : '[unknown]';
  const issuer = extra !== undefined && typeof extra.issuer === 'string' ? extra.issuer : '[local]';
  return JSON.stringify([issuer, subject, auth?.clientId ?? subject]);
}

function registryKey(principal: string, requestId: JsonRpcRequestId): string {
  return JSON.stringify([principal, typeof requestId, requestId]);
}

function jsonRpcMessages(body: unknown): readonly Record<string, unknown>[] {
  const candidates = Array.isArray(body) ? body : [body];
  return candidates.filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
  );
}

function jsonRpcRequestIds(body: unknown): readonly JsonRpcRequestId[] {
  return jsonRpcMessages(body)
    .filter(
      (message) =>
        message.jsonrpc === '2.0' &&
        typeof message.method === 'string' &&
        (typeof message.id === 'string' || typeof message.id === 'number'),
    )
    .map((message) => message.id as JsonRpcRequestId);
}

function cancellationNotifications(body: unknown): readonly JsonRpcRequestId[] {
  return jsonRpcMessages(body)
    .filter(
      (message) =>
        message.jsonrpc === '2.0' &&
        message.method === 'notifications/cancelled' &&
        message.id === undefined &&
        message.params !== null &&
        typeof message.params === 'object' &&
        !Array.isArray(message.params),
    )
    .map((message) => (message.params as Record<string, unknown>).requestId)
    .filter(
      (requestId): requestId is JsonRpcRequestId =>
        typeof requestId === 'string' || typeof requestId === 'number',
    );
}

function requiredScopesForRequest(body: unknown, runtime: Runtime): readonly string[] {
  if (Array.isArray(body)) {
    const scopes = new Set(body.flatMap((message) => requiredScopesForRequest(message, runtime)));
    return scopes.size === 0 ? ['newrelic:read'] : [...scopes];
  }
  if (body === null || typeof body !== 'object') {
    return ['newrelic:read'];
  }
  const request = body as Record<string, unknown>;
  if (request.method !== 'tools/call') return ['newrelic:read'];
  const params = request.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return ['newrelic:read'];
  }
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== 'string') return ['newrelic:read'];
  const gates: CapabilityGates = {
    enabledToolsets: runtime.config.toolsets,
    ...runtime.config.gates,
  };
  const spec = TOOL_CATALOG.find(
    (candidate) =>
      candidate.name === name &&
      isToolsetEnabled(gates, candidate.toolset) &&
      areSpecGatesEnabled(candidate, gates),
  );
  return [spec?.requiredScope ?? 'newrelic:read'];
}

export async function startHttpServer(
  runtime: Runtime,
  createServerInstance: McpServerFactory,
): Promise<HttpServer> {
  const app = await createHttpApp(runtime, createServerInstance);
  const server = createServer(app);
  server.requestTimeout = runtime.config.limits.timeoutMs + 5000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.listen(runtime.config.http.port, runtime.config.http.host);
  await once(server, 'listening');
  return server;
}

export async function closeHttpServer(server: HttpServer): Promise<void> {
  server.close();
  server.closeIdleConnections();
  const forced = setTimeout(() => server.closeAllConnections(), 10_000);
  forced.unref();
  try {
    await once(server, 'close');
  } finally {
    clearTimeout(forced);
  }
}

export function isHttpAuthError(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof AuthorizationError;
}
