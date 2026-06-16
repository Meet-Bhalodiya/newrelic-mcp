import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from './errors.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function extractBearerToken(authorization: string | undefined): string {
  if (authorization === undefined) throw new AuthenticationError();
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(authorization.trim());
  if (match?.[1] === undefined) throw new AuthenticationError('Invalid Authorization header');
  return match[1];
}

export function verifyBearerToken(authorization: string | undefined, expectedToken: string): void {
  const provided = extractBearerToken(authorization);
  if (!constantTimeEqual(provided, expectedToken))
    throw new AuthenticationError('Invalid bearer token');
}
