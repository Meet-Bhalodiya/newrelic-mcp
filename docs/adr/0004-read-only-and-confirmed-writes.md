# ADR-0004: Read-only defaults and two-phase writes

- Status: Accepted
- Date: 2026-07-15

## Context

MCP calls may be model-generated or prompt-injected. New Relic configuration updates
can replace omitted state, suppress telemetry, expose dashboards, revoke access, or
delete resources. A client approval prompt alone is not a sufficient server boundary.

## Decision

Do not register mutations unless their independent gate is enabled. Every write
defaults to dry-run, pre-reads state, returns a normalized diff and state-bound
confirmation phrase, requires identical normalized arguments to apply, and reads
back afterward. Destructive/admin/preview/experimental classes have separate gates.
Never retry a mutation with an uncertain result.

## Consequences

Writes require two calls and can fail on concurrent state changes. The process does
not provide an atomic distributed transaction, but accidental and injected changes
are materially harder. Operators should still separate read, write, and admin
deployments.
