import { describe, expect, it } from 'vitest';

import { NewRelicMcpError, toMcpError } from '../../src/errors.js';
import { asToolResult, errorEnvelope, successEnvelope } from '../../src/results.js';

describe('tool result envelopes', () => {
  it('returns the same JSON through structured and legacy text content', () => {
    const envelope = successEnvelope({ value: 42 }, { region: 'US', durationMs: 4 });
    const result = asToolResult(envelope, 1024);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(envelope);
    expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}')).toEqual(
      envelope,
    );
  });

  it('truncates oversized content without leaking the original data', () => {
    const envelope = successEnvelope({ secretLikePayload: 'x'.repeat(4096) }, { region: 'EU' });
    const result = asToolResult(envelope, 1024);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { omitted: true },
      meta: { region: 'EU', truncated: true },
    });
    expect(JSON.stringify(result)).not.toContain('x'.repeat(200));
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('budgets both legacy text and structured content against the response limit', () => {
    const envelope = successEnvelope({ value: 'x'.repeat(650) }, { region: 'US' });
    const result = asToolResult(envelope, 1024);

    expect(result.structuredContent.meta.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('marks public errors as MCP tool errors', () => {
    const envelope = errorEnvelope(
      { code: 'authorization', message: 'Not permitted.', retryable: false },
      { region: 'JP' },
    );
    expect(asToolResult(envelope, 1024)).toMatchObject({ isError: true });
  });

  it('hard-bounds error details and warnings as well as successful data', () => {
    const envelope = errorEnvelope(
      {
        code: 'upstream',
        message: 'x'.repeat(4096),
        retryable: true,
        details: { upstreamErrors: Array.from({ length: 100 }, () => 'y'.repeat(1024)) },
      },
      { region: 'US', warnings: ['z'.repeat(4096)] },
    );
    const result = asToolResult(envelope, 1024);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { meta: { truncated: true } },
    });
    expect(text).not.toContain('y'.repeat(100));
  });
});

describe('typed errors', () => {
  it('preserves typed errors and sanitizes unknown failures', () => {
    const typed = new NewRelicMcpError('rate_limited', 'Try later.', {
      retryable: true,
      retryAfterMs: 1000,
    });
    expect(toMcpError(typed)).toBe(typed);
    expect(toMcpError(new Error('sensitive upstream detail')).toPublic()).toEqual({
      code: 'internal',
      message: 'An internal error prevented the operation.',
      retryable: false,
    });
  });
});
