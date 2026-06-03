import { z } from 'zod';

import { ConfigurationError } from './config/index.js';
import { NewRelicMcpError } from './errors.js';
import { NerdGraphError } from './newrelic/index.js';
import { AuthenticationError, AuthorizationError } from './security/index.js';
import { CapabilityError, MutationOutcomeError } from './toolsets/errors.js';

export function normalizePublicError(error: unknown): NewRelicMcpError {
  if (error instanceof MutationOutcomeError) {
    const normalized = normalizePublicError(error.cause);
    const uncertain = [
      'rate_limited',
      'timeout',
      'upstream_schema',
      'upstream',
      'response_too_large',
      'internal',
    ].includes(normalized.code);
    if (!uncertain) return normalized;
    return new NewRelicMcpError(
      normalized.code,
      `${normalized.message} The mutation outcome is uncertain; verify current state before retrying.`,
      {
        retryable: false,
        ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
        details: { ...(normalized.details ?? {}), outcomeUncertain: true },
      },
    );
  }
  if (error instanceof NewRelicMcpError) return error;
  if (error instanceof AuthenticationError) {
    return new NewRelicMcpError('authentication', 'New Relic authentication failed.');
  }
  if (error instanceof AuthorizationError) {
    return new NewRelicMcpError('authorization', 'The operation is not authorized.', {
      ...(error.requiredScopes.length === 0
        ? {}
        : { details: { requiredScopes: error.requiredScopes } }),
    });
  }
  if (error instanceof ConfigurationError) {
    return new NewRelicMcpError('validation', 'Server configuration is invalid.', {
      details: { issues: error.issues },
    });
  }
  if (error instanceof CapabilityError) {
    return new NewRelicMcpError(mapCapabilityCode(error.code), error.message, {
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
    });
  }
  if (error instanceof NerdGraphError) {
    return new NewRelicMcpError(mapNerdGraphCode(error.code), error.message, {
      retryable: ['rate-limited', 'timeout', 'upstream'].includes(error.code),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.issues.length === 0
        ? {}
        : {
            details: {
              upstreamErrors: error.issues.map((issue) => ({
                message: issue.message,
                ...(issue.code === undefined ? {} : { code: issue.code }),
                ...(issue.path === undefined ? {} : { path: issue.path }),
              })),
            },
          }),
    });
  }
  if (error instanceof z.ZodError) {
    return new NewRelicMcpError('validation', 'Tool arguments failed validation.', {
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new NewRelicMcpError('timeout', 'The operation was cancelled or timed out.', {
      retryable: true,
    });
  }
  return new NewRelicMcpError('internal', 'An internal error prevented the operation.');
}

function mapCapabilityCode(code: CapabilityError['code']): NewRelicMcpError['code'] {
  const map: Record<CapabilityError['code'], NewRelicMcpError['code']> = {
    validation: 'validation',
    authentication: 'authentication',
    authorization: 'authorization',
    not_found: 'not_found',
    rate_limited: 'rate_limited',
    timeout: 'timeout',
    upstream_schema: 'upstream_schema',
    unsupported: 'unsupported',
    write_disabled: 'write_disabled',
    confirmation_required: 'confirmation_required',
  };
  return map[code];
}

function mapNerdGraphCode(code: NerdGraphError['code']): NewRelicMcpError['code'] {
  const map: Record<NerdGraphError['code'], NewRelicMcpError['code']> = {
    validation: 'validation',
    authentication: 'authentication',
    authorization: 'authorization',
    'not-found': 'not_found',
    'rate-limited': 'rate_limited',
    timeout: 'timeout',
    'upstream-schema': 'upstream_schema',
    unsupported: 'unsupported',
    upstream: 'upstream',
    'response-too-large': 'response_too_large',
    cancelled: 'timeout',
    'write-disabled': 'write_disabled',
  };
  return map[code];
}
