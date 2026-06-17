# Security and threat model

## Security posture

This server assumes MCP inputs can be model-generated, prompt-injected, malformed,
or actively hostile. It also assumes New Relic responses can contain customer data
and that upstream errors may leak implementation details. Its defaults minimize
capability, data volume, and credential exposure.

This is a self-hosted control. Operators remain responsible for New Relic RBAC,
network placement, identity provider policy, log storage, data residency, backups,
and incident response.

## Assets

- New Relic user key and the permissions of its owner.
- MCP bearer tokens and OIDC signing/authorization configuration.
- Observability data: logs, metrics, traces, incidents, dashboards, entities, and
  administrative metadata.
- Configuration state changed by mutation tools.
- Availability and rate-limit budget of the New Relic user/account.
- Audit records and server software supply chain.

## Trust boundaries

1. The MCP client/model is outside the server trust boundary.
2. The HTTP reverse proxy and identity provider are separately administered trust
   dependencies.
3. New Relic NerdGraph is an external data processor/API boundary.
4. Container orchestrator secret storage and runtime logs are operator-controlled.
5. Prometheus/OTLP collectors receive only safe operational metadata but remain
   external network destinations.

One deployment is single-tenant. It must not select different New Relic credentials
based on an untrusted caller or tool argument.

## Threats and controls

| Threat                                      | Primary controls                                                                                                                         | Residual risk                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Prompt injection causes a dangerous action  | Writes absent by default; dry-run; exact bound confirmation; destructive/admin gates; client approval                                    | An authorized user can intentionally confirm a harmful action.           |
| Cross-account data access                   | Numeric allowlist checked for every provable account/entity target; default account is not authorization; least-privilege New Relic user | Organization-wide admin objects are outside numeric account semantics.   |
| GraphQL injection                           | Fixed documents and variables; no raw GraphQL tool                                                                                       | Upstream parser/schema vulnerabilities.                                  |
| NRQL mutation/injection                     | Read-only lexer rejects `DELETE` and non-read constructs; bounded wrappers                                                               | Novel parser ambiguity; tests and fail-closed updates are required.      |
| Credential exfiltration                     | Credentials only at startup; no credential tool args/results; redaction; stdout cleanliness; file secrets                                | Host/root compromise or malicious dependency can access process secrets. |
| DNS rebinding/browser abuse                 | Exact Origin and Host checks; loopback default; no wildcard; auth                                                                        | Misconfigured reverse proxy or allowlist.                                |
| SSRF                                        | Fixed New Relic endpoints; no URL arguments; explicit trusted OIDC/JWKS/OTLP config                                                      | Compromised DNS/network infrastructure.                                  |
| Token confusion                             | JWT issuer, signature, audience, time, algorithm, and scope validation; protected-resource metadata                                      | Identity-provider compromise or incorrect audience design.               |
| Replay/stolen bearer token                  | TLS; high entropy; secure storage; rotation; short-lived OIDC preferred                                                                  | Static bearer has no intrinsic replay protection.                        |
| Denial of service/rate exhaustion           | Body/output/page limits; global and NRQL semaphores; deadlines; bounded read retries; no mutation retry                                  | Authorized callers can consume the deployment's fair share.              |
| Schema drift produces unsafe interpretation | Zod response validation; typed schema error; partial-data warning                                                                        | An upstream semantically changes a field without changing its shape.     |
| Sensitive data in logs/metrics              | Field allowlists; redaction; no bodies/arguments/NRQL/account labels                                                                     | Operator-added proxy/APM logging can still capture data.                 |
| Supply-chain compromise                     | Lockfile, pinned action digests, audit, CodeQL, secret scan, SBOM, container scan, provenance                                            | Registry or maintainer credential compromise.                            |

## Authentication and authorization

Stdio inherits local OS access: anyone who can launch the configured command and
read its environment can use the New Relic credential. Use a dedicated OS account
for shared systems.

HTTP `none` is loopback-only. Bearer mode compares a high-entropy static token
without logging it. OIDC mode implements an OAuth protected resource: it exposes
RFC 9728 metadata and points clients to an external authorization server. The
server validates JWTs locally and maps scopes to tool classes. It never sends MCP
tokens to New Relic; NerdGraph always receives the configured New Relic user key.

Hosted connectors may require OAuth. Static bearer mode is appropriate only for
clients/operators that explicitly support secure header configuration.

## Mutation policy

`NEW_RELIC_ENABLE_WRITES` expands the public attack surface and must be changed only
through reviewed deployment configuration. A write call without confirmation
performs no mutation. Its dry-run pre-reads state, computes a canonical diff, and
returns an exact phrase bound to the operation, normalized input, target, and
pre-read state. Apply rechecks state and refuses stale confirmation.

After an apply, the server performs an uncached readback. If the tool cannot prove
the requested target state from that response, the result is explicitly partial,
sets `verification.verified=false`, and directs the operator to verify it. An
in-flight timeout, rate limit, or upstream mutation failure is never marked
retryable because the mutation outcome may be uncertain.

The destructive gate covers deletes, cancellations, revocations, replacement-style
updates that can discard omitted fields, public sharing, and telemetry suppression.
Administration has its own independent gate. Use separate deployments for read,
write, and admin audiences instead of enabling every gate on one shared endpoint.

The admin gate and `newrelic:admin` scope are an explicit organization-scope trust
boundary for inherently organization-wide objects such as users, groups, custom
roles, and organization data policies. `NEW_RELIC_ACCOUNT_ALLOWLIST` cannot narrow
those objects. Run admin tools on a dedicated endpoint with a dedicated New Relic
service user, OIDC audience, and operator group. Account/entity-scoped grants, API
keys, updates, and cancellations still require resolvable ownership and must pass
the allowlist. Creating a new account cannot be pre-allowlisted; treat it as an
organization-level action and add the resulting ID to reviewed policy afterward.

No confirmation mechanism replaces backups, peer review, or New Relic RBAC.

## Data minimization

- Request the smallest page/range needed and avoid `SELECT *`.
- Keep `NEW_RELIC_MAX_RESPONSE_BYTES` at or below the default.
- Do not paste secrets, personal data, or regulated data into NRQL literals.
- Treat tool output as New Relic customer data subject to the client's retention,
  model-training, and data-residency policies.
- Do not expose `/metrics` or detailed logs to end users.
- Secure credential and API-key resources expose metadata only.

## Production hardening checklist

- [ ] Dedicated least-privilege New Relic user and user key.
- [ ] Explicit `NEW_RELIC_ACCOUNT_ALLOWLIST`.
- [ ] Only required toolsets; all unused gates false.
- [ ] TLS 1.2+ at a trusted proxy; no direct public pod/container port.
- [ ] OIDC with short-lived tokens for multi-user access, or a rotated 256-bit
      bearer token for tightly controlled service access.
- [ ] Exact Host and Origin allowlists; proxy strips inbound forwarding headers.
- [ ] Read-only root filesystem, non-root UID, dropped capabilities, seccomp,
      no service-account token, egress NetworkPolicy.
- [ ] Secrets mounted as files and excluded from backups/logs/core dumps.
- [ ] Rate/concurrency budget divided across replicas and other integrations.
- [ ] One replica, or authenticated deterministic affinity documented and tested
      for cross-request cancellation; proxy logs never include bearer values.
- [ ] `/metrics` uses HTTP auth and remains network-private; log/telemetry sinks have bounded retention.
- [ ] Dependency, image, and SBOM scanning in release pipeline.
- [ ] `doctor --json`, transport smoke tests, and a rollback procedure validated.

## Incident response

For suspected credential or data exposure:

1. Remove the endpoint from service and preserve sanitized audit metadata.
2. Revoke/rotate the New Relic key and MCP bearer/OIDC credentials at their source.
3. Search proxy, server, client, model, and collector logs for the affected period.
4. Review New Relic audit events and configuration changes from a separate trusted
   channel.
5. Replace pods/processes; do not only modify an in-place secret.
6. Narrow permissions/allowlists, remediate the root cause, and re-run `doctor`.
7. Follow organizational breach notification and New Relic support procedures.

Never include live credentials or customer data in a public issue. Follow
[SECURITY.md](../SECURITY.md) for private vulnerability disclosure.
