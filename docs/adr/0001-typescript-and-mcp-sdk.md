# ADR-0001: TypeScript and the production MCP SDK v1

- Status: Accepted
- Date: 2026-07-15

## Context

The server needs first-class MCP support, strict schemas, portable local execution,
small operational footprint, and compatibility across Node LTS releases. The MCP
TypeScript SDK v2 line remains prerelease while v1.29.0 is the production-recommended
line supporting protocol 2025-11-25.

## Decision

Use strict TypeScript ESM, Node 22.7.5+ compatibility, Node 24 LTS containers, npm,
Zod 4, and exactly `@modelcontextprotocol/sdk@1.29.0`. Target MCP 2025-11-25. Do not
adopt the prerelease split v2 SDK until it has a stable migration path and passes
the complete transport/conformance suite.

## Consequences

One language/schema system covers CLI, transports, operations, and tests. Node 20
is unsupported. SDK upgrades require explicit protocol compatibility review rather
than broad automated major updates.
