# Dependency policy

The maintained policy is [docs/dependency-policy.md](../docs/dependency-policy.md).
This summary is kept beside dependency automation for reviewer visibility.

Runtime dependencies must be necessary, actively maintained, compatible with
Node 22/24 and Apache-2.0 distribution, and reviewed for install scripts, network
behavior, transitive size, security history, and secret/data exposure. Prefer Node
built-ins and the official MCP SDK over convenience wrappers.

- Production dependencies and GitHub Actions are pinned exactly.
- `package-lock.json` is committed and CI uses `npm ci`.
- Renovate opens reviewed updates after a seven-day release age; major updates and
  MCP SDK updates are never automerged.
- CI runs `npm audit --audit-level=high`, CodeQL, TruffleHog, SBOM generation, and
  Trivy image scanning.
- A high/critical runtime advisory blocks release unless maintainers document why
  it is unreachable, its expiry date, compensating controls, and the tracking issue.
- Dependency removals are preferred over permanent vulnerability exceptions.
- SDK, auth/JWT, HTTP, schema-validation, logging/redaction, and telemetry changes
  require focused security and compatibility tests.

Generated SBOMs are release artifacts. They are not a substitute for reviewing what
code executes in the process that holds the New Relic user key.
