# New Relic MCP Server

<!-- mcp-name: io.github.Meet-Bhalodiya/newrelic-mcp -->

[![CI](https://github.com/Meet-Bhalodiya/newrelic-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Meet-Bhalodiya/newrelic-mcp/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.7.5-brightgreen.svg)](.nvmrc)

**Connect your AI assistant to New Relic — safely.**

A production-oriented, self-hostable [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that gives Claude, Cursor, Codex, and other MCP clients typed,
read-only-by-default access to NRQL, logs, metrics, traces, errors, entities, alerts,
incidents, dashboards, synthetics, workloads, service levels, and selected
administration APIs — all over New Relic's NerdGraph.

It deliberately does **not** expose arbitrary GraphQL, forward client credentials to
New Relic, or accept New Relic keys as tool arguments. Mutations are absent unless
their feature gates are explicitly enabled, and every write uses a dry-run,
confirmation phrase, and post-write readback workflow.

## Highlights

- 🔒 **Safe by default** — read-only out of the box; writes are opt-in, gated, and run a dry-run → confirmation-phrase → post-write readback flow.
- 🧱 **Bounded API surface** — a fixed, documented set of NerdGraph operations; no arbitrary GraphQL and no credentials passed as tool arguments.
- 🔌 **Works with any MCP client** — Claude Code, Claude Desktop, Cursor, Codex, and more, over stdio or stateless Streamable HTTP.
- 📈 **Usage telemetry built in** — a Prometheus `/metrics` endpoint with per-tool call counts, durations, and outcomes, plus upstream NerdGraph, queue-depth, retry, rate-limit, and cache metrics.
- 🏢 **Enterprise-ready** — bearer/OIDC authentication, Host/Origin allowlists, account allowlists, secret and PII redaction, Docker, and Helm.
- 🧰 **Broad coverage** — independently selectable toolsets for NRQL, entities, alerts, dashboards, synthetics, workloads, service levels, logs, and metrics.
- 📚 **Documented and tested** — architecture docs, ADRs, and a unit/integration/contract/security/load test suite that gates every change in CI.

## What you can ask

Once connected, ask your MCP client in plain language — it selects and calls the right read-only tools for you:

- "What are the slowest transactions for the checkout service in the last hour?"
- "Summarize the open incidents for the payments team and their likely causes."
- "Which service levels are at risk of missing their objective this week?"
- "Review my alert policies and point out coverage gaps."
- "Why did the login synthetic monitor fail overnight?"

See the [tool catalog](docs/tool-catalog.md) for the complete set of capabilities.

## Why this MCP?

New Relic offers an official, New Relic-hosted MCP server
([New Relic AI MCP](https://docs.newrelic.com/docs/agentic-ai/mcp/overview/), currently
in preview). This project is a complementary, **self-hostable and open-source**
alternative. Choose it when you want:

- **Self-hosting and control** — run the MCP bridge inside your own network with your
  own credentials; only outbound NerdGraph calls leave your perimeter. (New Relic's
  preview is not offered for FedRAMP-regulated accounts.)
- **Read-only by default, with gated writes** — every mutation is opt-in and runs a
  dry-run → confirmation-phrase → readback flow.
- **A fixed, auditable operation surface** — a documented set of NerdGraph operations,
  with no arbitrary GraphQL and no New Relic keys passed as tool arguments.
- **Your own controls** — bearer/OIDC auth, Host/Origin and account allowlists, secret
  redaction, and independently selectable toolsets.
- **First-class telemetry** — Prometheus metrics for tool usage and upstream calls that
  you can scrape into your existing observability stack.
- **Apache-2.0 and forkable** — inspect, pin, and extend exactly what you deploy.

If you'd rather have a zero-operations, New Relic-managed experience integrated with
New Relic AI, the official server may be the better fit. This project trades that
convenience for self-hosting, control, and auditability.

> Project status: 1.0.0. Review the [supported operation matrix](docs/source-matrix.md)
> and validate permissions against a non-production New Relic account before enabling
> writes. The MCP Registry, npm, container, and MCPB metadata are prepared, but this
> repository does not publish artifacts without maintainer credentials.

## Requirements

- Node.js 22.7.5 or newer; Node 24 LTS is recommended for production.
- A New Relic **user key** with only the permissions the enabled toolsets require.
- A New Relic account using the US or EU endpoint, or a verified JP compatibility
  endpoint deployment (see [configuration](docs/configuration.md#new-relic)).
- An MCP client supporting stdio or Streamable HTTP.

New Relic applies a limit of 25 concurrent NerdGraph requests per user across all
keys owned by that user. This server defaults to 20 total requests and five complex
NRQL queries. See [performance and scaling](docs/performance.md) before adding
replicas. Ordinary HTTP calls are sessionless; prompt SDK cancellation across
multiple replicas additionally requires deterministic load-balancer affinity.

## Quick start: stdio

Install the package globally:

```bash
npm install --global @meet-bhalodiya/newrelic-mcp
export NEW_RELIC_API_KEY='NRAK-...'
export NEW_RELIC_REGION='US'
newrelic-mcp doctor --json
newrelic-mcp
```

Or let the MCP client invoke the pinned package through `npx`:

```bash
NEW_RELIC_API_KEY='NRAK-...' \
  npx -y @meet-bhalodiya/newrelic-mcp@1.0.0 doctor --json
```

Stdio reserves stdout for MCP frames. Runtime diagnostics and logs go to stderr.

## Quick start: authenticated HTTP

Create two files readable only by the service account:

```bash
install -m 0700 -d ./secrets
printf '%s' "$NEW_RELIC_API_KEY" > ./secrets/new_relic_api_key
openssl rand -hex 32 > ./secrets/mcp_bearer_token
chmod 0400 ./secrets/*
```

Start a loopback-only container:

```bash
docker compose up --build
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; health probes are at `/healthz`
and `/readyz`. Docker Compose deliberately enables static bearer authentication.
Read the token from `./secrets/mcp_bearer_token` and send it in
`Authorization: Bearer <token>`.

For a native process:

```bash
export NEW_RELIC_API_KEY_FILE="$PWD/secrets/new_relic_api_key"
export MCP_AUTH_MODE=bearer
export MCP_BEARER_TOKEN_FILE="$PWD/secrets/mcp_bearer_token"
newrelic-mcp http --host 127.0.0.1 --port 3000
```

Non-loopback HTTP must use bearer or OIDC auth, an explicit Host allowlist, TLS at
the reverse proxy, and an Origin allowlist for browser clients. See
[deployment](docs/deployment.md) and [security](docs/security.md).

## Client setup

These short examples use the read-only stdio server. The full guide includes remote
bearer and OAuth setups plus client-specific caveats.

### Claude Code

```bash
claude mcp add --transport stdio --scope user \
  --env NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  --env NEW_RELIC_REGION=US \
  newrelic -- npx -y @meet-bhalodiya/newrelic-mcp@1.0.0
```

Use `/mcp` inside Claude Code to verify the connection.

### Claude Desktop

For the safest local installation, build or download the `.mcpb` bundle and use
**Settings → Extensions → Advanced settings → Install Extension**. Claude Desktop
stores fields marked sensitive in OS secure storage. A manual local stdio JSON
example is in [client configuration](docs/client-configuration.md). Remote servers
must be added through **Settings → Connectors**, not `claude_desktop_config.json`.

### Cursor

Copy [`examples/cursor.mcp.json`](examples/cursor.mcp.json) to `.cursor/mcp.json`
for one project or `~/.cursor/mcp.json` globally. Launch Cursor from an environment
where `NEW_RELIC_API_KEY` is available, then enable the server under MCP settings.

### Codex

```bash
codex mcp add newrelic \
  --env NEW_RELIC_REGION=US \
  --env NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  -- npx -y @meet-bhalodiya/newrelic-mcp@1.0.0
codex mcp list
```

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app on the same Codex
host share `config.toml`. See the [Codex examples](docs/client-configuration.md#codex)
for Streamable HTTP bearer and OAuth modes.

## CLI

```text
newrelic-mcp [stdio]
newrelic-mcp http [--host HOST] [--port PORT]
newrelic-mcp doctor [--json]
newrelic-mcp tools [--json]
```

- `stdio` (or no subcommand) starts the local transport.
- `http` serves sessionless Streamable HTTP at `/mcp` plus health endpoints; its
  bounded cancellation registry is process-local.
- `doctor` validates configuration, credentials, region, accessible accounts, and
  one bounded fixed-query schema selection for every effectively enabled toolset;
  it never issues mutations or prints secrets.
- `tools` reports enabled toolsets and safety gates without contacting New Relic.

## Safety model

| Capability                                                               |                      Default | Required setting                                         |
| ------------------------------------------------------------------------ | ---------------------------: | -------------------------------------------------------- |
| Read tools                                                               | enabled by selected toolsets | `NEW_RELIC_TOOLSETS`                                     |
| Ordinary writes                                                          |                          off | `NEW_RELIC_ENABLE_WRITES=true`                           |
| Delete, cancel, revoke, replacement update, public exposure, suppression |                          off | writes plus `NEW_RELIC_ENABLE_DESTRUCTIVE=true`          |
| Organization administration                                              |                          off | `NEW_RELIC_ENABLE_ADMIN=true` and appropriate auth scope |
| Preview data-management APIs                                             |                          off | `NEW_RELIC_ENABLE_PREVIEW_APIS=true`                     |
| Experimental AI issue actions                                            |                          off | `NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES=true`           |

Enabling a gate registers the corresponding tool; it does not bypass New Relic
permissions or HTTP authorization scopes. Writes still default to dry-run. Apply
the exact confirmation phrase returned by the dry-run using otherwise identical
arguments. Confirmation phrases bind to the normalized change and the pre-read state;
another state change requires a fresh dry-run.

The project deliberately excludes API-key creation, synthetic secure-credential
mutation, live-dashboard passwords and resets, historical-export URLs, Slack
destination creation, arbitrary entity deletion, telemetry ingest, and raw GraphQL.

## Toolsets and MCP capabilities

The default read surface is split into independently selectable toolsets:

- `core`
- `nrql`
- `entities`
- `alerts`
- `dashboards`
- `synthetics`
- `workloads`
- `service-levels`
- `logs`
- `metrics`
- `admin` (never enabled implicitly)

Use `newrelic-mcp tools --json` for the exact runtime catalog and
[tool-catalog.md](docs/tool-catalog.md) for descriptions. Resources include server
capabilities, accounts, and typed entity/configuration templates. Static prompts
cover incident triage, service health, alert policy review, SLO review, dashboard
design, and synthetic failure analysis. Tools remain the authoritative universal
interface because prompt and resource support varies between MCP clients.

## Configuration

Configuration is validated at startup. The most important settings are:

```dotenv
NEW_RELIC_API_KEY=                  # xor NEW_RELIC_API_KEY_FILE
NEW_RELIC_REGION=US                 # US, EU, or JP
NEW_RELIC_DEFAULT_ACCOUNT_ID=
NEW_RELIC_ACCOUNT_ALLOWLIST=
NEW_RELIC_TOOLSETS=core,nrql,entities
MCP_AUTH_MODE=none                  # none, bearer, oidc
```

File-based secrets are preferred for services and take the same value as their
environment equivalents. Do not set both forms. Review [configuration.md](docs/configuration.md)
for precedence, every setting, validation rules, and examples.

## Development

```bash
npm ci
npm run build
npm run lint
npm run typecheck
npm test
npm run verify
npm pack --dry-run
```

Run locally with a workspace-specific HTTP port:

```bash
CONDUCTOR_PORT=3100 npm run dev:http
```

Opt-in live tests require an explicit account and are read-only unless the separate
disposable-account write flag is set. See [development.md](docs/development.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [Tool catalog](docs/tool-catalog.md)
- [New Relic permissions and editions](docs/permissions.md)
- [Client configuration](docs/client-configuration.md)
- [Deployment](docs/deployment.md)
- [Performance](docs/performance.md)
- [Security and threat model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Official API source matrix](docs/source-matrix.md)
- [Release process](docs/releasing.md)
- [Dependency policy](docs/dependency-policy.md)
- [Architecture decisions](docs/adr/README.md)

## Contributing

Contributions are welcome — bug reports, features backed by official New Relic
documentation, docs, and tests. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[good first issues](https://github.com/Meet-Bhalodiya/newrelic-mcp/labels/good%20first%20issue).
All participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

If this project is useful to you or your team, a ⭐ helps others discover it.

## Support and security

Need help? See [SUPPORT.md](SUPPORT.md). Use
[GitHub Issues](https://github.com/Meet-Bhalodiya/newrelic-mcp/issues) for reproducible
bugs and feature requests, and never include New Relic keys, bearer tokens, NRQL,
account data, entity details, raw responses, or presigned URLs.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
