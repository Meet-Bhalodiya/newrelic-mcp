# Troubleshooting

Start with a sanitized diagnostic report:

```bash
npm run build
newrelic-mcp doctor --json
newrelic-mcp tools --json
```

Do not paste the raw output publicly without checking account counts, endpoint,
enabled gates, and capability names. The commands never intentionally print keys.

## Configuration fails at startup

- Set exactly one of `NEW_RELIC_API_KEY` and `NEW_RELIC_API_KEY_FILE`.
- Ensure a file secret is readable by the service UID and contains one non-empty
  line without quotes.
- Use `NEW_RELIC_REGION=US`, `EU`, or `JP` matching the key's organization.
- Make the default account a member of `NEW_RELIC_ACCOUNT_ALLOWLIST`.
- Keep NRQL concurrency at most five and no greater than total concurrency.
- In bearer mode, set exactly one bearer token value/file.
- For remote OIDC, set an HTTPS `MCP_OIDC_RESOURCE_URL` and exact audience.
- An unauthenticated non-loopback bind fails by design. Configure auth; do not use
  `MCP_ALLOW_INSECURE_REMOTE` outside a temporary isolated diagnostic.

## Authentication or `401`

For New Relic upstream auth failures, verify user-key type, region, user status, and
that no newline/quotes were stored in the secret file. Rotation requires a process
restart.

For MCP HTTP auth:

- Bearer: confirm the client sends `Authorization: Bearer …` and that proxy logs do
  not reveal it. Tokens are compared exactly.
- OIDC: inspect protected-resource metadata, issuer discovery/JWKS reachability,
  token `iss`, `aud`, `exp`/`nbf`, asymmetric algorithm, and scopes.
- Ensure the reverse proxy preserves `Authorization` and does not change the public
  resource URL.
- Claude/Codex/Cursor OAuth credentials may need clearing and a fresh login after
  issuer, audience, or scope changes.

## Host or Origin rejected

`MCP_HTTP_ALLOWED_HOSTS` must contain the hostname received by the application; ports are
normalized away. `MCP_HTTP_ALLOWED_ORIGINS` contains origins only—scheme,
host, and optional port, with no path. Browser clients send Origin; many native
clients do not. Do not solve this with a wildcard.

Check whether the proxy rewrites Host or passes untrusted forwarding headers. The
server validates the actual supplied values to prevent DNS rebinding.

## Tool is missing

Run `newrelic-mcp tools --json` and check:

1. its toolset is selected;
2. its write/destructive/admin/preview/experimental gate is enabled;
3. the process was restarted after configuration changed;
4. the client refreshed tool discovery;
5. a client-side enabled/disabled tool list is not filtering it.

This project intentionally does not register unsupported/secret-bearing tools.

## Permission, entitlement, or empty data

The New Relic service user may lack account/resource permission, the product may not
be entitled, the data may be outside retention, or the event type may not exist in
that account. Test the smallest equivalent operation in New Relic's NerdGraph/NRQL
UI under the same user. Do not add an API fallback to conceal a permission error.

## NRQL rejected

Only read queries are allowed. `DELETE`, multi-statement/non-read syntax, comments
used to obscure tokens, and overlong queries are rejected locally. Prefer one
bounded `SELECT` with an explicit time window and limit. Query timeout/rate errors
may require narrowing the query or using the async tools.

## Partial data or upstream schema error

NerdGraph can return data plus errors. The server returns only validated partial
data and flags `meta.partial`. Treat warnings as incomplete results. An
`upstream-schema` error means New Relic no longer matches the documented response
shape or a feature differs by entitlement; upgrade to a fixed server version or
file a sanitized issue with operation name and error code, not the raw response.

## `429` or slow requests

Reduce total/NRQL concurrency, replicas, and other tools sharing the New Relic user.
All keys for one user share the same 25-request limit. Inspect safe queue-depth,
retry, and rate-limit metrics. Narrow NRQL before increasing deadlines.

## Stdio client shows no server

- Run `node --version` (must be at least 22.7.5) and `npx … doctor --json` in the
  same non-interactive environment as the client.
- Use an absolute executable path if the GUI client does not inherit shell `PATH`.
- Ensure no application logs or banners go to stdout.
- Restart the client after editing configuration.
- On Claude Code use `/mcp`; on Codex use `codex mcp list`; on Cursor use MCP logs.
- In Claude Desktop, local JSON is only for stdio. Add remote servers in Connectors.

## HTTP client cannot initialize

Verify the URL ends in `/mcp`, transport is Streamable HTTP (not SSE), content types
are preserved, request bodies are not cached/transformed, and proxy timeouts exceed
the tool deadline. Ordinary request/response calls have no MCP session and do not
require sticky sessions. Cancellation notifications are separate POSTs backed by a
process-local in-flight registry; with multiple replicas, configure deterministic
affinity when prompt cancellation is required. Otherwise cancellation is
best-effort until the server deadline. See [performance.md](performance.md#cancellation-routing).

## Container or Kubernetes readiness fails

Inspect status and sanitized logs:

```bash
docker compose ps
docker compose logs --tail=100 newrelic-mcp

kubectl -n newrelic-mcp describe pod -l app.kubernetes.io/name=newrelic-mcp
kubectl -n newrelic-mcp logs deployment/newrelic-mcp --tail=100
```

Common causes are missing Secret keys, `0400` file ownership incompatible with a
custom UID, blocked DNS/HTTPS egress, incorrect Host/resource URL, and New Relic
region/auth failures. Do not print Secret objects or environment dumps.

## Getting help

Open a GitHub issue with version, OS/runtime, transport, client/version, safe error
code, enabled toolset names, and minimal reproduction. Remove credentials, tokens,
JWTs, account IDs, NRQL, entity identifiers, raw responses, and customer data.
Report vulnerabilities privately via [SECURITY.md](../SECURITY.md).
