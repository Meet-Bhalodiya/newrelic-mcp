# New Relic permissions and editions

## Credential type

Use a New Relic **user key** (`NRAK-…`) belonging to a dedicated service user. A
license/ingest key cannot call NerdGraph. The service user's role grants access;
the key itself does not narrow permissions. Do not reuse a human owner's key or a
key used by unrelated automation.

The server sends the user key in New Relic's `API-Key` header to the region-specific
NerdGraph endpoint. MCP bearer/OIDC tokens are never forwarded upstream.

## Least privilege

New Relic authorization depends on organization model, account access, role,
resource scope, product entitlement, and feature availability. Exact permission
names and predefined roles can evolve, so this project does not claim one universal
role. Build a custom role from the documented capabilities available in your New
Relic organization, validate it with `doctor`, then test each enabled toolset.

Recommended deployment tiers:

| Tier                       | New Relic access                                                                    | Server gates                                                      |
| -------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Query                      | View only for explicitly allowlisted accounts                                       | all gates false                                                   |
| Configuration operator     | View plus selected alert/dashboard/synthetic/workload/SLO configuration permissions | writes true; destructive false unless required                    |
| Data pipeline operator     | View plus logs/metric/pipeline configuration                                        | writes and separately reviewed preview/destructive gates          |
| Organization administrator | Organization/account/user/access/API-key administration                             | separate endpoint, admin true, tightly scoped OIDC audience/group |

Never infer authorization from `NEW_RELIC_DEFAULT_ACCOUNT_ID`. For account/entity
operations, the account allowlist and upstream permissions form the access boundary.
Inherently organization-wide admin objects cannot be narrowed by numeric account
allowlists; the independent admin gate/scope and a dedicated administrative
deployment are their authorization boundary.

## Capability guidance

| Toolset        | Typical New Relic capability/entitlement needed                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core / NRQL    | View account and query data for the relevant event types. Data access policies still apply.                                                                               |
| Entities       | View entities; tagging/relationship/golden-data writes require corresponding entity configuration rights.                                                                 |
| Alerts         | View alert policies, conditions, muting rules, issues, incidents, destinations, channels, and workflows; writes require alerts configuration permissions.                 |
| Dashboards     | View dashboards; writes require dashboard management permission. Public exposure remains destructive-gated.                                                               |
| Synthetics     | View monitors/locations/downtimes/credential metadata; writes require synthetic monitor/private-location/downtime management. Secure credential values are never exposed. |
| Workloads      | View workload entities/status; writes require workload management.                                                                                                        |
| Service levels | View service levels/results and maintenance windows; writes require service-level/maintenance management. No service-level delete tool exists.                            |
| Logs           | View log configuration; writes require parsing/partition/obfuscation configuration rights.                                                                                |
| Metrics        | View normalization/pipeline configuration; preview tools require the feature and mutation permissions.                                                                    |
| Admin          | Organization/account/user/group/role/grant/policy/API-key management. Use a dedicated administrative deployment.                                                          |

Some telemetry event types or configuration APIs require additional product
subscriptions, Data Plus, Advanced Compute, or feature rollout. A correct query can
therefore return an entitlement error or no data. The server maps this safely; it
does not fall back to an unsupported API.

## Region and cross-account behavior

`NEW_RELIC_REGION` selects the user key's data region. It does not migrate or proxy
data between regions. Cross-account NRQL is permitted only when the user can view
every requested account and every account passes the allowlist. Prefer one account
per request unless cross-account comparison is necessary.

## Validation procedure

1. Create the dedicated New Relic service user and assign the smallest candidate
   role/account set.
2. Create a user key and mount it as a file.
3. Set `NEW_RELIC_ACCOUNT_ALLOWLIST` to the intended accounts.
4. Start with only `core` and run `newrelic-mcp doctor --json`.
5. Enable one read toolset at a time and exercise representative reads.
6. For a write deployment, use a disposable account, enable only writes, dry-run a
   representative mutation, review the diff, apply it, verify readback, and clean up.
7. Add destructive/admin capability only after a separate access review.

Re-run this procedure when the New Relic role, subscription, account membership,
region, server version, or official API status changes.
