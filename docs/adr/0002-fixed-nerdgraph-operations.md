# ADR-0002: Fixed typed NerdGraph operations

- Status: Accepted
- Date: 2026-07-15

## Context

Arbitrary GraphQL would allow model-controlled selection, introspection, mutations,
large responses, and fields outside the redaction/account policy. REST fallbacks
would create divergent semantics and authentication paths.

## Decision

Use only fixed, documented NerdGraph documents with GraphQL variables and Zod
validation. Each operation records an official source. NRQL is allowed only through
bounded read wrappers and a local read-only validator. Do not expose raw GraphQL,
REST v2 fallback, or ingest APIs.

## Consequences

The public surface evolves deliberately and schema drift fails closed. Adding an
operation costs documentation and contract fixtures, but the server can enforce
account boundaries, output limits, error sanitation, and mutation classification.
