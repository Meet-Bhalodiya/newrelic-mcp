# Deployment guide

## Deployment profiles

| Profile                | Transport/auth                                  | Use                                      |
| ---------------------- | ----------------------------------------------- | ---------------------------------------- |
| Developer workstation  | stdio, local OS boundary                        | One user and one MCP client.             |
| Local service          | HTTP on `127.0.0.1`, bearer                     | Multiple local clients or a local proxy. |
| Remote service         | HTTPS reverse proxy, OIDC preferred             | Team/hosted clients.                     |
| Administrative enclave | Separate endpoint, OIDC admin scope, admin gate | Small operator group only.               |

Do not mix read-only and administrative audiences on the same deployment. One
deployment always maps to one New Relic user key and tenant boundary.

## Container image

Build and inspect locally:

```bash
docker build --target runtime -t newrelic-mcp:local .
docker image inspect newrelic-mcp:local
```

The runtime image uses Node 24 LTS, UID/GID 10001, no shell entrypoint, and no
development dependencies. The Compose example adds read-only root filesystem,
tmpfs, `no-new-privileges`, dropped capabilities, resource bounds, secret mounts,
health checks, and loopback-only published port.

```bash
install -m 0700 -d secrets
printf '%s' "$NEW_RELIC_API_KEY" > secrets/new_relic_api_key
openssl rand -hex 32 > secrets/mcp_bearer_token
chmod 0400 secrets/*
docker compose up --build --detach
docker compose ps
```

Compose reads ordinary settings from `.env` if present. Never store credentials in
that file for production; the two secrets use mounted files.

## Kubernetes with Helm

Create a namespace and secret without putting values in Helm release metadata:

```bash
kubectl create namespace newrelic-mcp
kubectl -n newrelic-mcp create secret generic newrelic-mcp \
  --from-file=new-relic-api-key=./secrets/new_relic_api_key \
  --from-file=mcp-bearer-token=./secrets/mcp_bearer_token
```

Create a private values file:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: newrelic-mcp.example.com
      paths:
        - path: /mcp
          pathType: Prefix
  tls:
    - secretName: newrelic-mcp-tls
      hosts: [newrelic-mcp.example.com]

config:
  allowedHosts: newrelic-mcp.example.com
  allowedOrigins: https://claude.ai
  accountAllowlist: '1234567'
```

Then render, inspect, and install:

```bash
helm lint helm/newrelic-mcp
helm template newrelic-mcp helm/newrelic-mcp \
  --namespace newrelic-mcp --values values.private.yaml > /tmp/newrelic-mcp.yaml
kubectl apply --dry-run=server -f /tmp/newrelic-mcp.yaml
helm upgrade --install newrelic-mcp helm/newrelic-mcp \
  --namespace newrelic-mcp --values values.private.yaml --wait
```

The chart defaults to one replica, `Recreate` strategy, no service-account token,
non-root/seccomp security contexts, read-only filesystem, resource limits, probes,
and a NetworkPolicy allowing DNS and outbound HTTPS. The chart automatically adds
its Service DNS names to the Host allowlist and sends a valid Host from probes.
Adjust the ingress namespace selector for your controller. The egress policy permits HTTPS to any address because
standard NetworkPolicy cannot portably select New Relic and OIDC FQDNs; use an
egress gateway or CNI FQDN policy where stronger control is required.

The optional Prometheus `ServiceMonitor` requires the Prometheus Operator CRD,
`metrics.enabled=true`, and bearer auth; it reuses the mounted MCP bearer Secret.
Set `metrics.serviceMonitor.networkPolicyNamespaceLabels` to the labels on the
Prometheus namespace; the chart adds that source to the ingress NetworkPolicy.
For OIDC deployments, configure an external OAuth-aware scraper instead.

When OIDC is selected, the chart also routes
`/.well-known/oauth-protected-resource/mcp` so clients can discover the protected
resource metadata. [`examples/helm-oidc-values.yaml`](../examples/helm-oidc-values.yaml)
shows the complete issuer/audience/resource setup. Helm refuses OIDC rendering unless
`auth.oidcIssuer`, `auth.oidcAudience`, and the public HTTPS `auth.resourceUrl` are set.

Before scaling, divide total/NRQL concurrency across the **maximum** simultaneous
replicas, including rollout surge, or use separately budgeted New Relic users. See
[performance.md](performance.md). HPA is intentionally off. MCP cancellation is a
separate HTTP POST and its in-flight registry is process-local. Keep one replica
for deterministic behavior, or configure security-reviewed deterministic affinity
so the original request and cancellation notification reach the same replica.
Ordinary calls do not require affinity. Without it, cancellation is best-effort
until the request deadline; this server does not provide a distributed cancellation
store. The performance guide includes ingress-nginx guidance and its token-routing
tradeoffs.

## OIDC and hosted clients

OIDC mode turns the server into an OAuth protected resource; it is not an
authorization server. Deploy an external issuer with:

- HTTPS discovery/JWKS;
- short-lived signed access tokens;
- exact audience for this MCP resource;
- `newrelic:read`, `newrelic:write`, and `newrelic:admin` scopes;
- PKCE and a client registration mechanism supported by each MCP client;
- refresh-token rotation/revocation appropriate for its risk policy.

Publish the server's RFC 9728 protected-resource metadata at the well-known path.
Unauthenticated `/mcp` requests return `401` with discovery information. The proxy
must pass `Authorization` unchanged, must not log it, and must not rewrite the
canonical resource URL.

Hosted Claude custom connectors require OAuth; add the public HTTPS endpoint under
Claude **Settings → Connectors**. A static bearer deployment is not a substitute.

## Reverse proxy requirements

- TLS 1.2+ with modern ciphers; redirect or close plaintext HTTP.
- Preserve POST request bodies and response streaming semantics for `/mcp`.
- Limit request bodies at or below `MCP_HTTP_MAX_BODY_BYTES`.
- Apply an idle timeout longer than the configured NRQL timeout.
- Strip client-supplied `Forwarded` and `X-Forwarded-*` headers before adding trusted
  values.
- Pass the original Host expected by `MCP_HTTP_ALLOWED_HOSTS`.
- Do not cache `/mcp`, auth metadata, readiness, or metrics responses.
- Disable request/response and Authorization header logging.
- Rate-limit per authenticated subject without using account IDs or NRQL as keys.
- With multiple replicas, configure provider-specific deterministic request
  affinity when prompt cross-request cancellation is required; do not confuse
  Kubernetes pod scheduling `affinity` with HTTP load-balancer affinity.

Only `/mcp` needs public routing. Keep `/readyz` and `/metrics` inside the cluster.
`/healthz` reveals little but still does not need public exposure.

## Secret rotation

1. Create a replacement New Relic user key or bearer secret at its source.
2. Update the mounted Secret atomically.
3. Restart one instance and run readiness plus `doctor --json` through a trusted
   administrative path.
4. Replace remaining instances while respecting the concurrency budget.
5. Revoke the old value only after all instances use the replacement.
6. Review logs for authentication or upstream failures.

For New Relic keys, remember that multiple keys for the same user share concurrency
limits. Rotation does not temporarily create a second budget.

## Rollback

Keep the previous immutable image digest and values. Roll back application and
configuration together:

```bash
helm history newrelic-mcp -n newrelic-mcp
helm rollback newrelic-mcp <revision> -n newrelic-mcp --wait
```

If a release introduced a mutation schema change, disable write/destructive/admin
gates before rollback and verify current New Relic state manually. Software rollback
does not undo upstream configuration changes.

## Systemd

[`deploy/systemd/newrelic-mcp.service`](../deploy/systemd/newrelic-mcp.service)
runs a native package as a dedicated `newrelic-mcp` user on loopback. Install build
artifacts under `/opt/newrelic-mcp`, secrets as root-owned files, ordinary settings
in `/etc/newrelic-mcp/environment`, then place a TLS/auth-capable proxy on the same
host. Run `systemd-analyze security newrelic-mcp.service` and address host-specific
recommendations before production use.
