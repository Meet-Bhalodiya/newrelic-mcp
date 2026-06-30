# Release process

Releases are prepared reproducibly but publication requires maintainer credentials
for npm, GitHub/GHCR, the MCP Registry, and any Helm/MCPB distribution channel.

## Versioning

Use Semantic Versioning. Before 1.0, treat tool renames/removals, schema changes,
configuration renames, default gate changes, protocol/transport changes, and auth
behavior changes as minor-version breaking changes. Security-only reductions in
capability may ship as a patch when necessary to protect users.

Keep these versions identical:

- `package.json`;
- `server.json` and its npm package entry;
- `mcpb.json`;
- `helm/newrelic-mcp/Chart.yaml` `appVersion` (and bump chart `version` for any
  chart change).

## Pre-release checklist

1. Review changed operations against [source-matrix.md](source-matrix.md), with
   special attention to preview/experimental APIs and deprecations.
2. Update `CHANGELOG.md`, documentation, and compatibility notes.
3. Run:

   ```bash
   npm ci
   npm run verify
   npm run test:integration
   npm run test:load
   npm audit --audit-level=high
   npm pack --dry-run
   ```

4. Validate registry and bundle manifests with the current official CLIs.
5. Build the image for supported architectures, run as non-root/read-only, scan it,
   and generate SPDX/CycloneDX SBOMs.
6. `helm lint`, render with a smoke-test values file, validate server-side, install
   into an ephemeral cluster, and exercise readiness plus authenticated `/mcp`.
7. Run MCP conformance and Inspector smoke tests for stdio and HTTP.
8. Optionally run live read-only tests in a dedicated account. Live writes require
   maintainer approval and a disposable account.
9. Confirm repository is clean and CI is green on Node 22 and 24.

## npm and provenance

Publish from GitHub Actions using npm trusted publishing/OIDC when available. The
package is public and requests provenance. Inspect the exact tarball first:

```bash
npm pack
tar -tf meet-bhalodiya-newrelic-mcp-*.tgz
npm publish --access public --provenance
```

The package must contain built `dist`, license, readme, changelog, security policy,
`server.json`, and `mcpb.json`, and must not contain tests, credentials, `.env*`,
coverage, `.context`, or source maps with sensitive paths.

## Containers and Helm

Publish immutable semver and commit-SHA tags to GHCR; attach SBOM and provenance,
then sign the digest with keyless OIDC signing. Never deploy mutable `latest` in
production. Update chart defaults only after the digest is available.

Package the chart and publish it through the chosen OCI registry:

```bash
helm package helm/newrelic-mcp
helm push newrelic-mcp-*.tgz oci://ghcr.io/meet-bhalodiya/charts
```

## MCP Registry

The registry identity is `io.github.Meet-Bhalodiya/newrelic-mcp`. `package.json` `mcpName`
must match. After npm publication, validate and publish `server.json` using the
current `mcp-publisher` release and GitHub OIDC/namespace ownership workflow. The
Registry is a discovery metadata service; it does not publish the npm package.

## MCPB

MCPB expects `manifest.json` inside the bundle. Copy/generate it from the versioned
`mcpb.json`, stage the built server and production dependencies, validate, and pack:

```bash
mkdir -p /tmp/newrelic-mcp-mcpb
cp -R dist /tmp/newrelic-mcp-mcpb/dist
cp package.json package-lock.json /tmp/newrelic-mcp-mcpb/
cp mcpb.json /tmp/newrelic-mcp-mcpb/manifest.json
npm ci --omit=dev --ignore-scripts --prefix /tmp/newrelic-mcp-mcpb
mcpb validate /tmp/newrelic-mcp-mcpb/manifest.json
mcpb pack /tmp/newrelic-mcp-mcpb newrelic-mcp-VERSION.mcpb
```

Test installation on a clean Claude Desktop profile. Secret fields must appear as
sensitive and the bundle must run without a system Node installation when the
client supplies its documented runtime. Sign and checksum the final artifact.

## Release and rollback

Create a signed Git tag and GitHub release containing changelog notes, checksums,
SBOMs, provenance links, package/image/chart/MCPB coordinates, compatibility, and
known issues. Do not claim publication until each registry confirms availability.

Rollback software by deploying the previous immutable artifacts. If a release made
New Relic configuration changes, disable mutation gates and reconcile state
separately; artifact rollback cannot undo upstream mutations.
