# ADR-0003: Stdio and stateless Streamable HTTP

- Status: Accepted
- Date: 2026-07-15

## Context

Local clients prefer stdio while shared/hosted clients require HTTP and OAuth. The
legacy HTTP+SSE transport is deprecated. Stateful MCP sessions complicate routing,
horizontal scaling, and failure recovery without adding value to this request/response
tool surface.

## Decision

Implement stdio and stateless Streamable HTTP at `/mcp`. Do not implement legacy
SSE, MCP Tasks, sampling, or resource subscriptions. HTTP defaults to loopback,
validates Host/Origin, and requires bearer/OIDC when non-loopback.

"Stateless" here means that ordinary request/response handling has no MCP session
or durable server state. The official SDK sends per-call cancellation as a separate
`notifications/cancelled` POST, so each process keeps a bounded, expiring registry
of its own in-flight request IDs, scoped to the authenticated principal.

## Consequences

Ordinary calls need no sticky sessions and replicas can be replaced independently.
Cross-request cancellation is prompt only when the cancellation POST reaches the
replica handling the original request. The chart therefore defaults to one replica;
multi-replica deployments that require prompt cancellation must configure stable,
security-reviewed load-balancer affinity. Without affinity, cancellation is
best-effort and the bounded server deadline remains the backstop. A shared
cancellation store or broker is deliberately not part of this implementation.

Server-initiated streaming/subscription workflows are unavailable. Long queries
use New Relic's asynchronous query tools rather than durable MCP session state.
