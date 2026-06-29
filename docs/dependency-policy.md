# Dependency policy

Runtime dependencies must be necessary, actively maintained, license-compatible
with Apache-2.0 distribution, and supported on the maintained Node.js lines. Prefer
Node built-ins and the production MCP SDK v1 line over convenience wrappers.

## Versions and updates

- npm and the committed `package-lock.json` are authoritative; CI and releases use
  `npm ci` and never a floating resolver.
- Production dependencies, development tools, container bases, conformance tools,
  and GitHub Actions are pinned. npm publication uses provenance.
- Renovate waits at least seven days after a release and groups only compatible
  development updates. Major versions and MCP SDK changes always require manual
  review, focused protocol/security tests, and a changelog entry.
- The stable `@modelcontextprotocol/sdk` v1 line is used until a reviewed migration
  to a stable successor passes both transports and the official conformance suite;
  prerelease SDK lines are not production dependencies.

## Runtime support

The package supports Node.js 22.7.5 and later and CI exercises Node 22 and 24. The
container uses Node 24 LTS. A Node line is removed no later than its upstream end of
life; removal is announced as a compatibility change before release. Production
operators should move to the newest tested LTS before the older line reaches EOL.

## Security and exceptions

Every change runs dependency audit, CodeQL, secret scanning, source/image SBOM
generation, and container vulnerability scanning. A high or critical runtime
advisory blocks release. A temporary exception requires all of:

1. evidence that the vulnerable path is unreachable or a compensating control;
2. a private security review and public tracking issue when disclosure is safe;
3. an owner and expiry date no more than 30 days away;
4. a tested upgrade/removal plan.

SDK, auth/JWT, HTTP, schema validation, logging/redaction, telemetry, and install
script changes receive focused supply-chain and data-exposure review. Dependency
removal is preferred over permanent exceptions. Generated SBOMs are release
artifacts, not substitutes for reviewing code that executes beside the New Relic
user key.
