import { AccountAccessError } from './errors.js';

export type AccountPolicy = {
  readonly defaultAccountId?: number | undefined;
  readonly accountAllowlist?: readonly number[] | undefined;
};

function validAccountId(accountId: number): boolean {
  return Number.isSafeInteger(accountId) && accountId > 0 && accountId <= 2_147_483_647;
}

function accountIdFromReference(value: unknown, path: string): number {
  const accountId =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!validAccountId(accountId)) {
    throw new AccountAccessError(`${path} must identify a positive GraphQL Int account`);
  }
  return accountId;
}

function isAccountIdKey(key: string): boolean {
  return /account(?:[_-]?ids?)$/iu.test(key);
}

function isAccountContainerKey(key: string): boolean {
  return /accounts?$/iu.test(key) && !isAccountIdKey(key);
}

/**
 * Find account references in typed GraphQL inputs, including targetAccountId,
 * managedAccount.id, and `{ type: "ACCOUNT", id: "…" }` scope objects.
 */
export function collectReferencedAccountIds(value: unknown, path = 'variables'): number[] {
  const output: number[] = [];
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, candidatePath: string, containerKey = ''): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) throw new AccountAccessError(`${candidatePath} contains a cycle`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${candidatePath}[${index}]`, containerKey));
      seen.delete(candidate);
      return;
    }
    const record = candidate as Record<string, unknown>;
    const accountScoped =
      String(record.type).toLocaleUpperCase('en-US') === 'ACCOUNT' ||
      String(record.scope).toLocaleUpperCase('en-US') === 'ACCOUNT';
    if ((accountScoped || isAccountContainerKey(containerKey)) && record.id !== undefined) {
      output.push(accountIdFromReference(record.id, `${candidatePath}.id`));
    }
    for (const [key, child] of Object.entries(record)) {
      const childPath = `${candidatePath}.${key}`;
      if (isAccountIdKey(key)) {
        const references = Array.isArray(child) ? child : [child];
        for (const reference of references) {
          output.push(accountIdFromReference(reference, childPath));
        }
        continue;
      }
      visit(child, childPath, key);
    }
    seen.delete(candidate);
  };
  visit(value, path);
  return [...new Set(output)];
}

export function isAccountAllowed(accountId: number, policy: AccountPolicy): boolean {
  if (!validAccountId(accountId)) return false;
  const allowlist = policy.accountAllowlist ?? [];
  return allowlist.length === 0 || allowlist.includes(accountId);
}

/** Resolve an omitted account to the configured default and enforce isolation. */
export function authorizeAccount(accountId: number | undefined, policy: AccountPolicy): number {
  const resolved = accountId ?? policy.defaultAccountId;
  if (resolved === undefined) {
    throw new AccountAccessError(
      'An account ID is required because no default account is configured',
    );
  }
  if (!validAccountId(resolved)) {
    throw new AccountAccessError('Account ID must be a positive GraphQL Int', resolved);
  }
  if (!isAccountAllowed(resolved, policy)) {
    // Deliberately avoid confirming whether an out-of-scope account exists.
    throw new AccountAccessError('Account is outside the configured allowlist', resolved);
  }
  return resolved;
}

export function assertAccountVariablesAllowed(value: unknown, policy: AccountPolicy): void {
  for (const accountId of collectReferencedAccountIds(value)) {
    if (!isAccountAllowed(accountId, policy)) {
      throw new AccountAccessError(
        'An account reference is outside the configured account policy',
        accountId,
      );
    }
  }
}
