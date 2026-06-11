import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PublicError } from './errors.js';

export const toolEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  pagination: z
    .object({
      nextCursor: z.string().nullable().optional(),
      totalCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().nonnegative().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  meta: z.object({
    requestId: z.string(),
    durationMs: z.number().nonnegative(),
    region: z.enum(['US', 'EU', 'JP']),
    partial: z.boolean(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  }),
});

export type ToolEnvelope = z.infer<typeof toolEnvelopeSchema>;

export type ResultMetaInput = {
  requestId?: string;
  startedAt?: number;
  durationMs?: number;
  region: 'US' | 'EU' | 'JP';
  partial?: boolean;
  truncated?: boolean;
  warnings?: readonly string[];
};

export function successEnvelope(
  data: unknown,
  meta: ResultMetaInput,
  pagination?: { nextCursor?: string | null; totalCount?: number },
): ToolEnvelope {
  return {
    ok: true,
    data,
    ...(pagination === undefined ? {} : { pagination }),
    meta: normalizeMeta(meta),
  };
}

export function errorEnvelope(error: PublicError, meta: ResultMetaInput): ToolEnvelope {
  return { ok: false, error, meta: normalizeMeta(meta) };
}

export function asToolResult(
  envelope: ToolEnvelope,
  maxBytes: number,
): CallToolResult & { readonly structuredContent: ToolEnvelope } {
  let normalized = envelope;
  let result = materializeToolResult(normalized);
  if (serializedResultBytes(result) > maxBytes) {
    normalized = {
      ok: envelope.ok,
      ...(envelope.error === undefined
        ? {}
        : {
            error: {
              code: envelope.error.code,
              message: envelope.error.message.slice(0, 128),
              retryable: envelope.error.retryable,
              ...(envelope.error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: envelope.error.retryAfterMs }),
            },
          }),
      data: {
        omitted: true,
        reason: 'Serialized tool output exceeded the configured response limit.',
      },
      meta: {
        ...envelope.meta,
        truncated: true,
        warnings: [
          ...envelope.meta.warnings,
          `Output exceeded ${maxBytes} bytes. Narrow the query or request a smaller page.`,
        ],
      },
    };
    result = materializeToolResult(normalized);
    // Error details and warnings can themselves be large. Keep a compact typed envelope as the
    // final fallback so the configured byte ceiling is a hard boundary, not a best effort.
    if (serializedResultBytes(result) > maxBytes) {
      normalized = {
        ok: envelope.ok,
        ...(envelope.error === undefined
          ? {}
          : {
              error: {
                code: envelope.error.code.slice(0, 64),
                message: 'Output omitted.',
                retryable: envelope.error.retryable,
              },
            }),
        data: { omitted: true },
        meta: {
          ...envelope.meta,
          requestId: envelope.meta.requestId.slice(0, 128),
          truncated: true,
          warnings: [],
        },
      };
      result = materializeToolResult(normalized);
    }
    if (serializedResultBytes(result) > maxBytes) {
      throw new RangeError('Configured MCP response limit is too small for a result envelope');
    }
  }

  return result;
}

function materializeToolResult(
  envelope: ToolEnvelope,
): CallToolResult & { readonly structuredContent: ToolEnvelope } {
  const text = JSON.stringify(envelope);
  return {
    content: [{ type: 'text', text }],
    structuredContent: envelope,
    ...(envelope.ok ? {} : { isError: true }),
  };
}

function serializedResultBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function normalizeMeta(meta: ResultMetaInput): ToolEnvelope['meta'] {
  return {
    requestId: meta.requestId ?? randomUUID(),
    durationMs: meta.durationMs ?? Math.max(0, Date.now() - (meta.startedAt ?? Date.now())),
    region: meta.region,
    partial: meta.partial ?? false,
    truncated: meta.truncated ?? false,
    warnings: [...(meta.warnings ?? [])],
  };
}
