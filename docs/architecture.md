# Architecture

## Goals and boundaries

New Relic MCP Server is a single-tenant protocol adapter. One process uses one
server-side New Relic user key and exposes a deliberately bounded subset of the
New Relic query and configuration plane. It is not a telemetry collector, an API
gateway, a credential broker, or a general GraphQL client.

The design optimizes for predictable schemas, safe model invocation, transport
portability, and operator control. The same tool registry is exposed over stdio
and sessionless Streamable HTTP. A narrowly scoped, process-local cancellation
registry is the only cross-request runtime bridge; it is described under
[Transports](#transports).

```text
MCP client
   │
   ├── stdio ───────────────────────────────┐
   └── HTTPS /mcp ─ auth ─ Host/Origin ────┤
                                             ▼
                                  MCP capability registry
                                  toolsets + safety gates
                                             │
                                  Zod input + account policy
                                             │
                                  operation/service layer
                                             │
                        semaphore + timeout + read-only retries
                                             │
                  fixed NerdGraph document + GraphQL variables
                                             │
                         api[.eu|.jp].newrelic.com/graphql
                                             │
                        Zod response validation + redaction
                                             │
                  bounded structuredContent and JSON text
```

## Runtime layers

### Configuration

One strict schema loads environment values and mounted secret files, rejects
ambiguous or unsafe combinations, normalizes account IDs, selects the region
endpoint, and computes enabled capabilities. Configuration is immutable after
startup. `doctor --json` verifies the effective configuration and upstream access,
then uses bounded fixed reads to check each effectively enabled toolset without
issuing mutations; `tools --json` reports capabilities without reading credentials.

### Transports

Stdio writes only protocol frames to stdout; diagnostics go to stderr. Streamable
HTTP serves sessionless request/response MCP at `/mcp`: there is no MCP session
routing or server-sent event compatibility endpoint. Each process does retain a
bounded, short-lived in-flight registry so a later `notifications/cancelled` POST
can abort matching work for the same authenticated principal. Ordinary requests
can sit behind an ordinary load balancer, but this cancellation bridge is
process-local. Deployments with multiple replicas must use deterministic affinity
for the original request and its cancellation notification when prompt
cancellation is required; otherwise cancellation is best-effort until the server
deadline. A distributed cancellation coordinator is not implemented.

HTTP middleware applies request IDs, body limits, Host and Origin checks,
authentication/authorization, content negotiation, MCP dispatch, safe error
mapping, and access logging. `/healthz` checks process liveness. `/readyz` checks
validated startup state. `/metrics` is disabled by default and must be protected
when enabled.

### Capability registry

Toolsets are independent modules registered from configuration. Read tools are
annotated read-only. Mutation, destructive, admin, preview, and experimental tools
are not merely rejected at call time—they are absent from discovery until their
gate is enabled. HTTP scopes provide a second authorization layer.

Resources are read-only views using `newrelic://` URIs. Prompts contain static
workflow guidance and accept bounded parameters. Server instructions place the
critical read-only, account, and confirmation rules in their first 512 characters
for clients that truncate instructions.

### NerdGraph client

Every operation has:

1. a fixed GraphQL document;
2. a typed variable schema;
3. a response schema;
4. sensitivity and retry metadata;
5. a documented official source.

User values never form GraphQL syntax. NRQL is data inside a variable and passes a
read-only lexer/validator before transmission. The client uses persistent HTTP
connections, abort propagation, a global semaphore (20 by default), and a separate
complex-NRQL semaphore (five by default).

Reads may be retried up to three times with bounded exponential backoff and full
jitter for 429 and transient upstream failures. Mutations are never retried when
the outcome is uncertain. New Relic `Retry-After` guidance is honored within the
caller deadline.

### Response pipeline

GraphQL can return data and errors together. Valid partial data is retained only
when the response schema accepts it; the result sets `meta.partial=true` and adds
sanitized warnings. Upstream extensions, internal GraphQL text, headers, and raw
payloads are not returned.

Successful tools use this envelope:

```json
{
  "ok": true,
  "data": {},
  "pagination": { "nextCursor": null },
  "meta": {
    "requestId": "...",
    "durationMs": 42,
    "region": "US",
    "partial": false,
    "truncated": false,
    "warnings": []
  }
}
```

The same JSON is emitted as `structuredContent` and serialized text for older MCP
clients. Normal responses are capped at 1 MiB. List pages default to 100 items;
entity search respects New Relic's 200-item maximum, and NRQL respects the 5,000
result ceiling. Typed errors distinguish input validation, authentication,
authorization, not-found, rate limit, timeout, schema drift, unsupported behavior,
disabled writes, and missing confirmation.

## Write transaction

Writes are application-level two-phase operations, not distributed transactions:

1. Validate input, gate, account policy, and permissions.
2. Pre-read the target.
3. Normalize desired and current state.
4. Return a stable diff and a confirmation phrase bound to normalized input and pre-read state (`dryRun=true`).
5. On a second call with identical normalized arguments and that phrase, re-read
   and reject if the target changed.
6. Execute once, without automatic mutation retry.
7. Read back the result and return warnings if convergence cannot be verified.

The result sets `data.verification.verified=false` and `meta.partial=true` unless a
tool-specific validator proves the requested state from that uncached readback. This
prevents an account-level pre-read or a merely successful mutation payload from being
misrepresented as target-state verification.

Replacement updates, deletes, cancellations, revocations, public exposure, and
data suppression require both write and destructive gates. This reduces accidental
changes but cannot make an inherently non-transactional upstream mutation atomic.

## Caching

Small, non-sensitive metadata reads may use bounded in-memory TTL caching. Cache
keys include region, effective account boundary, operation, and normalized variables.
Mutations invalidate related entries. NRQL results, credentials, secure fields,
presigned URLs, and errors are never cached. Sessionless HTTP refers to the absence
of MCP session state; per-process metadata caches and the bounded in-flight
cancellation registry are safe but intentionally non-coherent between replicas.

## Observability

Pino emits structured runtime and audit events. OpenTelemetry and Prometheus are
optional. Safe metrics cover tool duration/status, upstream duration/status,
semaphore queue depth, retries, rate limits, truncation, and cache hits. Account
IDs, entity GUIDs, NRQL, arguments, response data, and token-derived values are
forbidden labels.

See [ADR-0001](adr/0001-typescript-and-mcp-sdk.md),
[ADR-0002](adr/0002-fixed-nerdgraph-operations.md), and
[ADR-0003](adr/0003-stateless-streamable-http.md).
