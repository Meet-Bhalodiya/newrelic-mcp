const MUTATING_KEYWORDS = new Set([
  'ALTER',
  'CALL',
  'CREATE',
  'DELETE',
  'DROP',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'INSERT',
  'MERGE',
  'REPLACE',
  'REVOKE',
  'TRUNCATE',
  'UPDATE',
  'UPSERT',
]);

const READ_PREFIXES = new Set(['EXPLAIN', 'FROM', 'SELECT', 'SHOW', 'WITH']);

export class NrqlValidationError extends Error {
  readonly code = 'validation';

  constructor(message: string) {
    super(message);
    this.name = 'NrqlValidationError';
  }
}

/**
 * Strip literals and comments before inspecting control tokens. This prevents a
 * harmless word such as `message = 'deleted'` from being treated as a mutation,
 * while still finding an injected second statement.
 */
export function nrqlControlText(query: string): string {
  let output = '';
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
    'normal';
  for (let index = 0; index < query.length; index += 1) {
    const character = query.charAt(index);
    const next = query[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'normal';
        output += '\n';
      } else output += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (state !== 'normal') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (character === '\\' && next !== undefined) {
        output += '  ';
        index += 1;
        continue;
      }
      // NRQL/SQL convention escapes quotes by doubling them.
      if (character === delimiter && next === delimiter) {
        output += '  ';
        index += 1;
        continue;
      }
      if (character === delimiter) state = 'normal';
      output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (character === '-' && next === '-') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (character === "'") {
      output += ' ';
      state = 'single';
    } else if (character === '"') {
      output += ' ';
      state = 'double';
    } else if (character === '`') {
      output += ' ';
      state = 'backtick';
    } else {
      output += character;
    }
  }
  if (
    state === 'single' ||
    state === 'double' ||
    state === 'backtick' ||
    state === 'block-comment'
  ) {
    throw new NrqlValidationError('NRQL contains an unterminated literal or comment');
  }
  return output;
}

export function assertReadOnlyNrql(query: string, maxLength = 16_384): string {
  const normalized = query.trim();
  if (normalized.length === 0) throw new NrqlValidationError('NRQL must not be empty');
  if (normalized.length > maxLength) {
    throw new NrqlValidationError(`NRQL exceeds the ${maxLength}-character limit`);
  }
  if (normalized.includes('\0')) throw new NrqlValidationError('NRQL contains a null byte');
  const control = nrqlControlText(normalized);
  if (control.includes(';')) {
    throw new NrqlValidationError('Multiple NRQL statements are not allowed');
  }
  const tokens = control.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  const first = tokens[0];
  if (first === undefined || !READ_PREFIXES.has(first)) {
    throw new NrqlValidationError(
      'Only read-only NRQL SELECT/FROM/SHOW/EXPLAIN queries are allowed',
    );
  }
  const mutating = tokens.find((token) => MUTATING_KEYWORDS.has(token));
  if (mutating !== undefined) {
    throw new NrqlValidationError(`NRQL operation ${mutating} is not allowed`);
  }
  return normalized;
}

export function isComplexNrql(query: string): boolean {
  const control = nrqlControlText(query).toUpperCase();
  return (
    /\b(?:FACET|TIMESERIES|COMPARE\s+WITH|JOIN)\b/.test(control) || /\(\s*FROM\b/.test(control)
  );
}

/** Add a limit when omitted and reject a request above New Relic's documented maximum. */
export function ensureBoundedNrql(query: string, defaultLimit = 100, maximumLimit = 5_000): string {
  const normalized = assertReadOnlyNrql(query);
  const control = nrqlControlText(normalized);
  const matches = [...control.matchAll(/\bLIMIT\s+(\d+|MAX)\b/gi)];
  if (matches.length === 0) {
    return /^\s*(?:SHOW|EXPLAIN)\b/iu.test(control)
      ? normalized
      : `${normalized}\nLIMIT ${defaultLimit}`;
  }
  if (matches.length > 1)
    throw new NrqlValidationError('NRQL must contain at most one LIMIT clause');
  const requested = matches[0]?.[1]?.toUpperCase();
  if (requested === 'MAX' || requested === undefined || Number(requested) > maximumLimit) {
    throw new NrqlValidationError(`NRQL LIMIT must not exceed ${maximumLimit}`);
  }
  return normalized;
}
