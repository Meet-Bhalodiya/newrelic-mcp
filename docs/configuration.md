# Configuration reference

The server reads configuration once at startup and fails closed on invalid values.
Environment names are case-sensitive. Empty strings are treated as unset unless a
field explicitly allows them.

## Precedence and secrets

For a secret with both value and file variants, configure exactly one:

```text
NEW_RELIC_API_KEY xor NEW_RELIC_API_KEY_FILE
MCP_BEARER_TOKEN xor MCP_BEARER_TOKEN_FILE       (bearer mode)
```

File variants contain the raw value, optionally followed by one newline. They are
preferred in containers and services because values do not appear in process
environment inspection. Files must be regular, readable by the service user, and
not group/world-readable. The server never reloads secrets automatically; rotate
by replacing the mounted secret and restarting instances one at a time.

Command-line `http --host` and `--port` override `MCP_HTTP_HOST` and
`MCP_HTTP_PORT`. Other settings have no CLI override.

## New Relic

| Setting                        |            Default | Meaning                                                                                                            |
| ------------------------------ | -----------------: | ------------------------------------------------------------------------------------------------------------------ |
| `NEW_RELIC_API_KEY`            |               none | New Relic user key. Secret.                                                                                        |
| `NEW_RELIC_API_KEY_FILE`       |               none | File containing the user key. Secret.                                                                              |
| `NEW_RELIC_REGION`             |               `US` | `US`, `EU`, or `JP`; selects the fixed NerdGraph endpoint.                                                         |
| `NEW_RELIC_DEFAULT_ACCOUNT_ID` |               none | Account used only when a tool allows omitted `accountId`.                                                          |
| `NEW_RELIC_ACCOUNT_ALLOWLIST`  |               none | Comma-separated numeric account IDs. Empty means all accounts visible to the key. Production should always set it. |
| `NEW_RELIC_TOOLSETS`           | documented default | Comma-separated toolset IDs or `all`. `all` still does not bypass safety gates.                                    |

Endpoints are fixed by region and cannot be overridden in production:

| Region | NerdGraph endpoint                    |
| ------ | ------------------------------------- |
| US     | `https://api.newrelic.com/graphql`    |
| EU     | `https://api.eu.newrelic.com/graphql` |
| JP     | `https://api.jp.newrelic.com/graphql` |

New Relic's public NerdGraph documentation currently names only the US and EU
endpoints. The JP hostname is retained because it is a project requirement and was
deployment-verified to resolve and return the expected unauthenticated API response;
confirm it with `doctor` and your New Relic account team before production use. It
must not be treated as a documented third New Relic data-hosting region until New
Relic publishes that contract.

## Safety gates

All gates default to `false`.

| Setting                                   | Effect                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NEW_RELIC_ENABLE_WRITES`                 | Registers ordinary create/update tools. Writes remain dry-run by default.                                                          |
| `NEW_RELIC_ENABLE_DESTRUCTIVE`            | Registers delete/cancel/revoke, replacement update, public exposure, and data-suppression tools. Requires writes where applicable. |
| `NEW_RELIC_ENABLE_ADMIN`                  | Registers organization administration tools. HTTP callers also need `newrelic:admin`.                                              |
| `NEW_RELIC_ENABLE_PREVIEW_APIS`           | Registers explicitly supported New Relic preview operations.                                                                       |
| `NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES` | Registers `aiIssues` actions and sends New Relic's unsafe experimental opt-in header only for those operations.                    |

Invalid combinations fail startup; for example, destructive without writes or
experimental issue actions without the alerts toolset.

## Limits and performance

| Setting                        |   Default | Valid guidance                                                   |
| ------------------------------ | --------: | ---------------------------------------------------------------- |
| `NEW_RELIC_CONCURRENCY`        |      `20` | `1..24`. Budget across every replica/user key.                   |
| `NEW_RELIC_NRQL_CONCURRENCY`   |       `5` | `1..5` and no greater than total concurrency.                    |
| `NEW_RELIC_TIMEOUT_MS`         |   `30000` | Overall ordinary upstream deadline.                              |
| `NEW_RELIC_NRQL_TIMEOUT_MS`    |   `60000` | Upstream deadline for bounded NRQL operations.                   |
| `NEW_RELIC_MAX_RESPONSE_BYTES` | `1048576` | Serialized MCP result limit. Lower it for small-context clients. |
| `NEW_RELIC_CACHE_TTL_MS`       |       `0` | TTL for eligible non-sensitive metadata; `0` disables caching.   |
| `NEW_RELIC_CACHE_MAX_ENTRIES`  |     `500` | Maximum in-memory cache entries; `0` disables storage.           |

Tool arguments impose their own page and row limits. Increasing a server limit
cannot exceed New Relic's official API limit.

## HTTP server

| Setting                     |        Default | Meaning                                                                                             |
| --------------------------- | -------------: | --------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_HOST`             |    `127.0.0.1` | Listen address.                                                                                     |
| `MCP_HTTP_PORT`             |         `3000` | Listen port.                                                                                        |
| `MCP_HTTP_ALLOWED_HOSTS`    | loopback hosts | Comma-separated exact hostnames/IPs. A supplied port is normalized away. Required for non-loopback. |
| `MCP_HTTP_ALLOWED_ORIGINS`  |           none | Comma-separated exact origins. Requests with an Origin are rejected unless listed.                  |
| `MCP_HTTP_MAX_BODY_BYTES`   |      `1048576` | Maximum request body before parsing.                                                                |
| `MCP_ALLOW_INSECURE_REMOTE` |        `false` | Emergency break-glass. Requires an explicit warning and should never be used in production.         |

Do not use `*` in Host or Origin allowlists. Configure the external hostname, not
an untrusted forwarded header, unless the reverse proxy is trusted and strips
incoming forwarding headers.

For compatibility with early deployments, `MCP_ALLOWED_HOSTS`,
`MCP_ALLOWED_ORIGINS`, and `MCP_RESOURCE_URL` remain accepted aliases. Prefer the
`MCP_HTTP_*` and `MCP_OIDC_RESOURCE_URL` names in new configuration.

## HTTP authentication

`MCP_AUTH_MODE` is `none`, `bearer`, or `oidc`.

### None

Allowed only on loopback. Health endpoints remain unauthenticated; `/mcp` follows
the selected mode. An unauthenticated non-loopback listener is rejected unless the
break-glass setting is true.

### Static bearer

| Setting                 |  Required | Meaning                                   |
| ----------------------- | --------: | ----------------------------------------- |
| `MCP_BEARER_TOKEN`      |  xor file | High-entropy bearer token, 32–8192 bytes. |
| `MCP_BEARER_TOKEN_FILE` | xor value | Mounted bearer token file, 32–8192 bytes. |

Generate at least 256 random bits. The token authorizes the capabilities registered
on that deployment, so use separate deployments/tokens for different trust tiers.

### OIDC/JWT resource server

| Setting                 |    Required | Meaning                                                                      |
| ----------------------- | ----------: | ---------------------------------------------------------------------------- |
| `MCP_OIDC_ISSUER`       |         yes | Exact trusted issuer URL.                                                    |
| `MCP_OIDC_AUDIENCE`     |         yes | Required JWT audience, normally the public MCP resource URL.                 |
| `MCP_OIDC_JWKS_URI`     |    normally | HTTPS JWKS endpoint; use explicit configuration if discovery is unavailable. |
| `MCP_OIDC_ALGORITHMS`   |          no | Comma-separated asymmetric allowlist; defaults to `RS256,ES256`.             |
| `MCP_OIDC_RESOURCE_URL` | remote OIDC | Canonical HTTPS MCP resource URL used in RFC 9728 metadata.                  |

The server verifies issuer, signature, expiry/not-before, audience, algorithm, and
scopes. It does not issue tokens. Configure an external authorization server that
supports PKCE and registered clients, Client ID Metadata Documents, or Dynamic
Client Registration as required by the connecting client.

Scopes:

- `newrelic:read` — read tools and resources;
- `newrelic:write` — registered ordinary/destructive write tools;
- `newrelic:admin` — registered administration tools (read or write).

Gate configuration and token scope are both required; neither implies the other.

## Logging and telemetry

| Setting                 |        Default | Meaning                                                                    |
| ----------------------- | -------------: | -------------------------------------------------------------------------- |
| `LOG_LEVEL`             |         `info` | `fatal`, `error`, `warn`, `info`, `debug`; avoid trace in production.      |
| `MCP_METRICS_ENABLED`   |        `false` | Enables `/metrics`; it uses the same HTTP authentication policy as `/mcp`. |
| `MCP_TELEMETRY_ENABLED` |        `false` | Enables OpenTelemetry spans when an SDK/exporter is preloaded externally.  |
| `OTEL_SERVICE_NAME`     | `newrelic-mcp` | Stable service name for an externally preloaded OpenTelemetry SDK.         |

Exporter settings use the standard OpenTelemetry `OTEL_*` environment variables
when an SDK is preloaded by the operator; this package does not embed or configure
an OTLP exporter. Logs never intentionally include credentials, request/response bodies, raw GraphQL,
NRQL, account IDs, entity GUIDs, presigned URLs, live-dashboard passwords, or tool
arguments. Treat runtime logs as sensitive operational metadata regardless.

## Examples

Read-only local stdio:

```dotenv
NEW_RELIC_API_KEY_FILE=/Users/me/.secrets/new-relic-user-key
NEW_RELIC_REGION=EU
NEW_RELIC_DEFAULT_ACCOUNT_ID=1234567
NEW_RELIC_ACCOUNT_ALLOWLIST=1234567
NEW_RELIC_TOOLSETS=core,nrql,entities,alerts
```

Remote OIDC deployment:

```dotenv
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_ALLOWED_HOSTS=newrelic-mcp.example.com
MCP_HTTP_ALLOWED_ORIGINS=https://claude.ai,https://cursor.com
MCP_AUTH_MODE=oidc
MCP_OIDC_ISSUER=https://identity.example.com/
MCP_OIDC_AUDIENCE=https://newrelic-mcp.example.com/mcp
MCP_OIDC_JWKS_URI=https://identity.example.com/.well-known/jwks.json
MCP_OIDC_ALGORITHMS=RS256,ES256
MCP_OIDC_RESOURCE_URL=https://newrelic-mcp.example.com/mcp
```

Run `newrelic-mcp doctor --json` after every configuration or permission change.
It serially runs one bounded, cache-bypassing fixed read query for every effectively
enabled toolset, with a 30-second ceiling per probe; it never issues mutations.
Its JSON is designed for automation but can still reveal capability names and
account counts; do not publish it unreviewed.
