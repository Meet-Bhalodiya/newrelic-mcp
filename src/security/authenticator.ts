import type { HttpAuthConfig } from '../config/types.js';
import { verifyBearerToken } from './bearer.js';
import type { AuthPrincipal, OidcVerifier } from './oidc.js';
import { createConfiguredOidcVerifier, requireScopes } from './oidc.js';

const TRUSTED_LOCAL_SCOPES = new Set(['newrelic:read', 'newrelic:write', 'newrelic:admin']);

export type Authenticator = (
  authorization: string | undefined,
  requiredScopes?: readonly string[],
) => Promise<AuthPrincipal>;

function trustedPrincipal(subject: string): AuthPrincipal {
  return {
    subject,
    issuer: undefined,
    audience: [],
    scopes: TRUSTED_LOCAL_SCOPES,
    clientId: undefined,
  };
}

export async function createAuthenticator(
  config: HttpAuthConfig,
  oidcVerifier?: OidcVerifier,
): Promise<Authenticator> {
  if (config.mode === 'none') return () => Promise.resolve(trustedPrincipal('local'));
  if (config.mode === 'bearer') {
    return (authorization, requiredScopes = []) => {
      verifyBearerToken(authorization, config.token);
      const principal = trustedPrincipal('static-bearer');
      requireScopes(principal.scopes, requiredScopes);
      return Promise.resolve(principal);
    };
  }
  const verifier = oidcVerifier ?? (await createConfiguredOidcVerifier(config));
  return (authorization, requiredScopes = []) =>
    verifier.verifyAuthorization(authorization, requiredScopes);
}
