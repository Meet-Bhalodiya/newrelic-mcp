# Development and verification

## Toolchain

Use Node.js 22.7.5 or newer. CI runs Node 22 and 24; production containers use
Node 24 LTS. npm and `package-lock.json` are authoritative—do not introduce a second
package manager or regenerate the lock with an unsupported npm version.

```bash
npm ci
npm run build
npm run verify
```

## Repository structure

```text
src/                 runtime, transports, security, operations, toolsets
test/unit/           pure configuration/security/operation tests
test/contract/       NerdGraph request/response fixtures and schema drift
test/integration/    SDK-client tests for stdio and HTTP
test/security/       auth, injection, isolation, leakage, confirmation
test/load/           mock-upstream concurrency/latency/memory tests
test/live/           opt-in New Relic tests
docs/                operator and maintainer documentation
deploy/              service deployment examples
helm/newrelic-mcp/   Kubernetes chart
examples/            client configuration examples
```

Tests must not depend on ordering, public internet access, real time beyond fake
timers, or a developer's New Relic account unless they are explicitly in `test/live`.

## Checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run test:integration
npm run test:load
npm run build
npm pack --dry-run
```

Use the official SDK client for transport integration tests. Stdio tests assert
that stdout contains only MCP protocol output. HTTP tests cover initialization,
discovery, structured results, auth/scopes, Host/Origin rejection, body limits,
same-process cancellation and caller disconnects, malformed messages, readiness,
and graceful shutdown. Multi-replica cancellation depends on the deployment's
routing policy and is not simulated by the process-local integration suite.

Contract fixtures cover success, data-plus-errors, permission, entitlement,
schema drift, 429, timeout, validation, and mutation-specific errors for every
operation. Fixtures must be synthetic and contain no copied customer data.

## Local HTTP loop

```bash
export NEW_RELIC_API_KEY_FILE=/absolute/path/to/new-relic-user-key
export NEW_RELIC_ACCOUNT_ALLOWLIST=1234567
export MCP_AUTH_MODE=none
CONDUCTOR_PORT=3100 npm run dev:http
```

The development listener remains loopback-only. For HTTP auth tests, use a random
test bearer token and never reuse a production secret.

## Conductor workspaces

Shared Conductor settings live in `.conductor/settings.toml`. Setup runs `npm ci`.
Run actions provide HTTP development, tests, and the full local check. Run mode is
`concurrent` because each workspace receives its own `$CONDUCTOR_PORT`; the server
has no local database or fixed shared resource.

`.worktreeinclude` copies only `.env.local` into a new workspace. This is convenient
for local credentials but also expands their footprint: protect the root file,
limit its key, archive workspaces promptly, and never commit it. Conductor runs on
macOS and allocates ten ports per workspace.

Shared `.conductor/settings.toml` changes become active in Conductor only after they
are merged into the remote default branch (`origin/master`). A workspace-branch
change alone does not update repository settings in the app.

## Live tests

Read-only live tests are opt-in:

```bash
export NEW_RELIC_LIVE_TESTS=true
export NEW_RELIC_API_KEY_FILE=/path/to/test-user-key
export NEW_RELIC_LIVE_TEST_ACCOUNT_ID=1234567
npm run test:live
```

The account must be disposable/non-production and present in the account allowlist.
Live write tests require a second explicit flag defined by the test harness. They
create uniquely prefixed fixtures, verify readback, and clean up in `finally`.
Never run live writes from pull requests, forks, or a shared production user.

## Adding an operation

1. Verify current official documentation and record the source URL.
2. Define a fixed operation name/document, strict variables schema, and strict
   response schema.
3. Decide read/mutation, complex NRQL, experimental-header, sensitivity, and cache
   metadata.
4. Add account authorization before the upstream call.
5. Add the tool schema and safety classification; for writes add dry-run, pre-read,
   canonical diff, confirmation binding, and post-write readback.
6. Add full contract fixtures and tool/transport tests.
7. Update the tool catalog, source matrix, changelog, and threat model if needed.

Do not use public GraphQL introspection as sole support evidence. Do not retry
mutations with uncertain results.
