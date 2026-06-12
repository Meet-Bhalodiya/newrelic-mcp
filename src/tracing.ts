import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('newrelic-mcp');

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  callback: () => Promise<T>,
  enabled = true,
): Promise<T> {
  if (!enabled) return await callback();
  return await tracer.startActiveSpan(name, { attributes }, async (span: Span) => {
    try {
      const result = await callback();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (error instanceof Error) {
        span.recordException({ name: error.name, message: 'Operation failed' });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
