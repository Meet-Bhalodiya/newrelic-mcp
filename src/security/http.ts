import { isIP } from 'node:net';
import { AuthorizationError } from './errors.js';

function hostnameFromAuthority(authority: string): string | undefined {
  if (
    authority.includes('/') ||
    authority.includes('\\') ||
    authority.includes('@') ||
    authority.includes('\0')
  ) {
    return undefined;
  }
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeAllowedHost(host: string): string {
  return hostnameFromAuthority(host) ?? host.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (hostHeader === undefined || allowedHosts.length === 0) return false;
  const hostname = hostnameFromAuthority(hostHeader);
  if (hostname === undefined) return false;
  return allowedHosts.some((allowed) => normalizeAllowedHost(allowed) === hostname);
}

export function assertAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: readonly string[],
): void {
  if (!isAllowedHost(hostHeader, allowedHosts)) throw new AuthorizationError('Host is not allowed');
}

export function isAllowedOrigin(
  originHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  // Non-browser clients generally omit Origin. Any supplied Origin must be validated.
  if (originHeader === undefined) return true;
  if (originHeader === 'null' || allowedOrigins.length === 0) return false;
  try {
    const parsed = new URL(originHeader);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.origin !== originHeader.replace(/\/$/, '')
    ) {
      return false;
    }
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function assertAllowedOrigin(
  originHeader: string | undefined,
  allowedOrigins: readonly string[],
): void {
  if (!isAllowedOrigin(originHeader, allowedOrigins))
    throw new AuthorizationError('Origin is not allowed');
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}
