# Security policy

## Supported versions

Until the first stable release, only the latest release receives security fixes.
After 1.0, the current major release and the immediately previous major release
will receive fixes for at least 90 days after a superseding major release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for
`Meet-Bhalodiya/newrelic-mcp` (**Security → Report a vulnerability**). If that feature is
unavailable, contact the repository owner through a private channel listed on the
GitHub profile. Do not open a public issue.

Include the affected version/commit, deployment mode, reproduction steps, impact,
and a minimal proof of concept. Remove New Relic keys, MCP bearer tokens, JWTs,
account IDs, NRQL, entity data, raw responses, and presigned URLs. We aim to
acknowledge a complete report within five business days and will coordinate
disclosure after a fix is available.

## Security boundaries

The server is a single-tenant bridge to one server-side New Relic user key. It is
not a multi-tenant credential broker. The operator must enforce network isolation,
TLS, identity, account allowlists, and least-privilege New Relic permissions.
Enabling writes or admin tools changes the deployment's risk profile.

See [docs/security.md](docs/security.md) for the threat model, auth model, secret
handling, mutation controls, logging policy, hardening checklist, and incident
response guidance.
