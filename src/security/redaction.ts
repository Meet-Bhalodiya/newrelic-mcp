const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /(?:authorization|api[-_]?key|token|secret|password|credential|cookie|set-cookie|private[-_]?key|client[-_]?secret|query|document|variables|response|tool[-_]?input|presigned|download[-_]?url)|^(?:arguments|body|data|input)$/i;
const SECRET_VALUE = /(?:\bBearer\s+[^\s,;]+|\b(?:NRAK|NRAA|NRII|NRRA)-[A-Za-z0-9_-]{8,})/gi;
const URL_CANDIDATE = /https?:\/\/[^\s"'<>]+/giu;
const SENSITIVE_URL_PARAMETER =
  /^(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|credential|password|secret|sig|signature|token|x-amz-.+|x-goog-.+)$/iu;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;

export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'apiKey',
  'token',
  'password',
  'secret',
  'query',
  'document',
  'variables',
  'response',
  'data',
] as const;

/** True when a URL carries credentials in userinfo or a secret-bearing query parameter. */
export function containsSecretBearingUrl(input: string): boolean {
  for (const match of input.matchAll(URL_CANDIDATE)) {
    try {
      const candidate = new URL(match[0]);
      if (candidate.username !== '' || candidate.password !== '') return true;
      for (const key of candidate.searchParams.keys()) {
        if (SENSITIVE_URL_PARAMETER.test(key)) return true;
      }
    } catch {
      // It only looked like a URL. Other redaction rules still apply to the original text.
    }
  }
  return false;
}

export function redactText(input: string, maximumLength = 1_024): string {
  const sanitized = input
    .replace(URL_CANDIDATE, (candidate) =>
      containsSecretBearingUrl(candidate) ? REDACTED : candidate,
    )
    .replace(SECRET_VALUE, REDACTED)
    .replace(EMAIL_ADDRESS, REDACTED)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return sanitized.length > maximumLength ? `${sanitized.slice(0, maximumLength)}…` : sanitized;
}

export function redact(value: unknown, maxDepth = 8): unknown {
  const seen = new WeakSet<object>();
  function visit(current: unknown, depth: number, key?: string): unknown {
    if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === 'string') return redactText(current);
    if (current === null || typeof current !== 'object') return current;
    if (depth >= maxDepth) return '[MAX_DEPTH]';
    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);
    if (Array.isArray(current)) {
      const output = current.map((entry) => visit(entry, depth + 1));
      seen.delete(current);
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(current)) {
      output[childKey] = visit(child, depth + 1, childKey);
    }
    seen.delete(current);
    return output;
  }
  return visit(value, 0);
}

export function redactHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([name, headerValue]) => [
      name.toLowerCase(),
      SENSITIVE_KEY.test(name)
        ? REDACTED
        : redactText(Array.isArray(headerValue) ? headerValue.join(', ') : (headerValue ?? '')),
    ]),
  );
}

export type SafeUpstreamError = {
  readonly message: string;
  readonly code?: string;
  readonly path?: readonly (string | number)[];
};

export function sanitizeUpstreamError(error: unknown): SafeUpstreamError {
  if (error === null || typeof error !== 'object')
    return { message: 'New Relic returned an upstream error' };
  const candidate = error as Record<string, unknown>;
  const rawMessage =
    typeof candidate.message === 'string'
      ? candidate.message
      : typeof candidate.description === 'string'
        ? candidate.description
        : typeof candidate.details === 'string'
          ? candidate.details
          : 'New Relic returned an upstream error';
  const extension =
    candidate.extensions !== null && typeof candidate.extensions === 'object'
      ? (candidate.extensions as Record<string, unknown>)
      : undefined;
  const rawCode = extension?.code ?? extension?.errorClass ?? candidate.code ?? candidate.type;
  const code = typeof rawCode === 'string' ? redactText(rawCode, 128) : undefined;
  const path = Array.isArray(candidate.path)
    ? candidate.path
        .filter(
          (part): part is string | number => typeof part === 'string' || typeof part === 'number',
        )
        .slice(0, 16)
    : undefined;
  return {
    message: redactText(rawMessage, 512),
    ...(code === undefined ? {} : { code }),
    ...(path === undefined ? {} : { path }),
  };
}
