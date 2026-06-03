import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../src/config/index.js';
import { normalizePublicError } from '../../src/error-mapping.js';
import { NewRelicMcpError } from '../../src/errors.js';
import { NerdGraphError, type NerdGraphErrorCode } from '../../src/newrelic/index.js';
import { AuthenticationError, AuthorizationError } from '../../src/security/index.js';
import { CapabilityError, MutationOutcomeError } from '../../src/toolsets/errors.js';

describe('public error normalization', () => {
  it('preserves public errors and maps configuration, auth, capability, Zod, abort, and unknown failures', () => {
    const publicError = new NewRelicMcpError('not_found', 'missing');
    expect(normalizePublicError(publicError)).toBe(publicError);
    expect(normalizePublicError(new ConfigurationError(['bad value']))).toMatchObject({
      code: 'validation',
    });
    expect(normalizePublicError(new AuthenticationError())).toMatchObject({
      code: 'authentication',
    });
    expect(normalizePublicError(new AuthorizationError('no', ['newrelic:admin']))).toMatchObject({
      code: 'authorization',
      details: { requiredScopes: ['newrelic:admin'] },
    });
    expect(
      normalizePublicError(new CapabilityError('confirmation_required', 'confirm')),
    ).toMatchObject({ code: 'confirmation_required' });
    const zodFailure = z.object({ value: z.string() }).safeParse({ value: 1 });
    if (zodFailure.success) throw new Error('Expected invalid fixture');
    expect(normalizePublicError(zodFailure.error)).toMatchObject({ code: 'validation' });
    expect(normalizePublicError(new DOMException('cancelled', 'AbortError'))).toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    expect(normalizePublicError(new Error('private detail'))).toMatchObject({ code: 'internal' });
  });

  it.each<[NerdGraphErrorCode, string]>([
    ['validation', 'validation'],
    ['authentication', 'authentication'],
    ['authorization', 'authorization'],
    ['not-found', 'not_found'],
    ['rate-limited', 'rate_limited'],
    ['timeout', 'timeout'],
    ['upstream-schema', 'upstream_schema'],
    ['unsupported', 'unsupported'],
    ['upstream', 'upstream'],
    ['response-too-large', 'response_too_large'],
    ['cancelled', 'timeout'],
    ['write-disabled', 'write_disabled'],
  ])('maps NerdGraph %s to %s', (source, expected) => {
    const normalized = normalizePublicError(
      new NerdGraphError(source, 'safe upstream failure', {
        retryAfterMs: 123,
        issues: [{ message: 'safe issue', code: 'FIXTURE', path: ['actor'] }],
      }),
    );
    expect(normalized).toMatchObject({
      code: expected,
      retryAfterMs: 123,
      details: {
        upstreamErrors: [{ message: 'safe issue', code: 'FIXTURE', path: ['actor'] }],
      },
    });
  });

  it.each<NerdGraphErrorCode>(['timeout', 'rate-limited', 'upstream-schema'])(
    'never tells callers to retry an uncertain %s mutation failure',
    (source) => {
      const normalized = normalizePublicError(
        new MutationOutcomeError(new NerdGraphError(source, 'safe upstream failure')),
      );

      expect(normalized).toMatchObject({
        retryable: false,
        details: { outcomeUncertain: true },
      });
      expect(normalized.message).toContain('verify current state before retrying');
    },
  );
});
