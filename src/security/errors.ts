export class AuthenticationError extends Error {
  readonly code = 'authentication';
  readonly status = 401;

  constructor(message = 'Authentication required', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  readonly code = 'authorization';
  readonly status = 403;
  readonly requiredScopes: readonly string[];

  constructor(message = 'Insufficient permissions', requiredScopes: readonly string[] = []) {
    super(message);
    this.name = 'AuthorizationError';
    this.requiredScopes = requiredScopes;
  }
}

export class AccountAccessError extends AuthorizationError {
  readonly accountId: number | undefined;

  constructor(message: string, accountId?: number) {
    super(message);
    this.name = 'AccountAccessError';
    this.accountId = accountId;
  }
}
