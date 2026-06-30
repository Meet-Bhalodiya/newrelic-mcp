# Contributing

Thank you for improving New Relic MCP Server. Contributions should preserve its
read-only defaults, fixed-operation API boundary, and compatibility across stdio
and Streamable HTTP clients.

## Development setup

1. Install Node.js 22.7.5 or newer (Node 24 LTS recommended) and npm.
2. Fork and clone the repository.
3. Run `npm ci`.
4. Copy `.env.example` to `.env.local` for local-only values. Never commit keys.
5. Run `npm run verify` before opening a pull request.

Useful commands:

```bash
npm run dev
npm run dev:http
npm run format
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:load
npm run build
npm pack --dry-run
```

## New Relic operations

Every new upstream operation must:

- be supported by current official New Relic documentation;
- use a fixed GraphQL document and variables—never user-supplied GraphQL;
- validate inputs and responses with Zod;
- enforce account allowlists before issuing the request;
- declare whether it is read-only, a write, destructive, admin, preview, or
  experimental;
- avoid secret-bearing response fields and redact safe error details;
- include success, partial-data, permission, entitlement, schema-drift,
  rate-limit, timeout, and validation contract fixtures;
- update `docs/tool-catalog.md` and `docs/source-matrix.md`.

Do not add undocumented schema fields based only on introspection. New Relic can
change or remove unsupported fields without notice. Do not add REST v2 fallbacks,
telemetry ingest, raw GraphQL, or a generic entity delete tool.

## Pull requests

Keep changes focused and explain user-visible behavior, security impact, tests,
and documentation updates. New write tools need an explicit threat-model review.
Changes to MCP protocol versions, transports, auth, safety gates, redaction,
confirmation logic, or response limits require an architecture decision record.

Pull requests must pass formatting, strict type checking, tests, coverage,
package/container smoke checks, dependency review, CodeQL, secret scanning, and
SBOM/vulnerability checks. Live tests are not run for untrusted forks.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in all project spaces.
