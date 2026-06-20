# MCP capability catalog

The runtime catalog is authoritative: run `newrelic-mcp tools --json` to see the
tools registered for the current toolsets and gates. This document describes the
complete build-time catalog.

Flags:

- **R** — read-only; HTTP OIDC requires `newrelic:read` unless **A**.
- **W** — requires `NEW_RELIC_ENABLE_WRITES`, `newrelic:write`, and dry-run/apply.
- **D** — additionally requires `NEW_RELIC_ENABLE_DESTRUCTIVE`.
- **A** — requires the admin toolset/gate and `newrelic:admin`.
- **P** — additionally requires `NEW_RELIC_ENABLE_PREVIEW_APIS`.
- **X** — additionally requires `NEW_RELIC_ENABLE_EXPERIMENTAL_AI_ISSUES` and New
  Relic's unsafe experimental `AiIssues` opt-in for that operation only.

All **W** tools accept `dryRun` (default `true`) and optional `confirmation`. Apply
uses `dryRun=false` plus the exact phrase returned by an otherwise identical dry-run.

## Core

| Tool               | Flags | Purpose                                                                 |
| ------------------ | ----- | ----------------------------------------------------------------------- |
| `connection_check` | R     | Validate the user key and return sanitized connection/account metadata. |
| `accounts_list`    | R     | List accessible accounts after applying the account allowlist.          |

## NRQL and telemetry

| Tool                | Flags | Purpose                                                                  |
| ------------------- | ----- | ------------------------------------------------------------------------ |
| `nrql_query`        | R     | Run one bounded, read-only NRQL query in an authorized account.          |
| `nrql_async_start`  | R     | Start a long-running read-only NRQL query.                               |
| `nrql_async_status` | R     | Poll an asynchronous query ID.                                           |
| `nrql_async_cancel` | W,D   | Cancel an asynchronous query; never automatically retried.               |
| `logs_query`        | R     | Read-only NRQL restricted to `Log`.                                      |
| `metrics_query`     | R     | Read-only NRQL restricted to `Metric`.                                   |
| `traces_query`      | R     | Read-only NRQL restricted to `Span`.                                     |
| `trace_get`         | R     | Read a distributed trace graph through `actor.distributedTracing.trace`. |
| `errors_query`      | R     | Read-only NRQL restricted to supported error event types.                |

Every NRQL string is length-bounded and locally validated as read-only. Normal
results cannot exceed New Relic's 5,000-row maximum or the server response limit.

## Entities

| Tool                         | Flags | Purpose                                                         |
| ---------------------------- | ----- | --------------------------------------------------------------- |
| `entities_search`            | R     | Search entities with official cursor pagination (max 200/page). |
| `entities_get`               | R     | Read entity identity, health, reporting, metadata, and tags.    |
| `entity_relationships_list`  | R     | Read incoming/outgoing relationships.                           |
| `entity_golden_data_get`     | R     | Read effective golden metrics and tags.                         |
| `entity_tags_add`            | W     | Add tag values without replacing unrelated tags.                |
| `entity_tags_remove`         | W,D   | Remove selected tag keys.                                       |
| `entity_tags_replace`        | W,D   | Replace the complete tag set.                                   |
| `entity_relationship_put`    | W,D   | Create or replace a documented user-defined relationship.       |
| `entity_relationship_delete` | W,D   | Delete a user-defined relationship.                             |

There is no generic `entity_delete` tool. Entity lifecycle varies by type and some
entities are recreated from telemetry.

## Alerts and incident response

| Tool                                               | Flags | Purpose                                                                  |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `alert_policies_list`, `alert_policy_get`          | R     | Read alert policies.                                                     |
| `alert_conditions_list`, `alert_condition_get`     | R     | Read NRQL alert conditions.                                              |
| `muting_rules_list`                                | R     | Read muting rules and schedules.                                         |
| `notifications_list`                               | R     | Read destination/channel/workflow metadata without secrets.              |
| `issues_list`, `incidents_list`                    | R     | Query stable bounded `NrAiIssue`/`NrAiIncident` history.                 |
| `alert_policy_create`, `alert_policy_update`       | W     | Create/update a policy.                                                  |
| `alert_policy_delete`                              | W,D   | Delete a policy.                                                         |
| `alert_condition_create`, `alert_condition_update` | W     | Create/update a static NRQL condition.                                   |
| `alert_condition_delete`                           | W,D   | Delete a condition.                                                      |
| `muting_rule_create`                               | W     | Create a muting rule.                                                    |
| `muting_rule_update`, `muting_rule_delete`         | W,D   | Replace schedule fields or delete a rule.                                |
| `notification_create`                              | W     | Create a supported destination, channel, or workflow. Slack is rejected. |
| `notification_update`, `notification_delete`       | W,D   | Update/delete a supported notification resource.                         |
| `notification_test`                                | W     | Send a test through an existing channel.                                 |
| `issue_acknowledge`, `issue_unacknowledge`         | W,X   | Experimental issue state actions.                                        |
| `issue_resolve`                                    | W,D,X | Experimentally resolve an issue.                                         |

## Dashboards

| Tool                                                | Flags | Purpose                                                                          |
| --------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `dashboards_list`, `dashboard_get`                  | R     | List/read dashboards without live-sharing secrets.                               |
| `dashboard_create`                                  | W     | Create a dashboard.                                                              |
| `dashboard_update`                                  | W,D   | Replace a complete dashboard definition.                                         |
| `dashboard_page_update`, `dashboard_widgets_update` | W,D   | Apply a complete caller-merged dashboard after reviewing the current definition. |
| `dashboard_delete`, `dashboard_undelete`            | W,D   | Soft-delete or restore a dashboard.                                              |

New Relic dashboard update is replacement-style: omitted pages, widgets, or
variables can be removed. The focused page/widget tools still submit a complete
merged definition and therefore remain destructive-gated.

## Synthetics

| Tool                                                                     | Flags | Purpose                                                                                                       |
| ------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------- |
| `synthetic_monitors_list`, `synthetic_monitor_get`                       | R     | Read monitor metadata/config without secure values.                                                           |
| `synthetic_locations_list`                                               | R     | List private-location entity metadata; public location identifiers are monitor inputs.                        |
| `synthetic_downtimes_list`                                               | R     | List monitor downtime schedules.                                                                              |
| `synthetic_secure_credentials_list`                                      | R     | List secure-credential entity identity/name/tag metadata only; never keys or values.                          |
| `synthetic_monitor_create`                                               | W     | Create ping, simple-browser, scripted-browser, scripted-API, step, certificate-check, or broken-link monitor. |
| `synthetic_monitor_update`, `synthetic_monitor_delete`                   | W,D   | Update a typed monitor or delete it.                                                                          |
| `synthetic_private_location_create`                                      | W     | Create private-location metadata.                                                                             |
| `synthetic_private_location_update`, `synthetic_private_location_delete` | W,D   | Update/delete private-location metadata.                                                                      |
| `synthetic_downtime_create`                                              | W     | Create monitor downtime.                                                                                      |
| `synthetic_downtime_update`, `synthetic_downtime_delete`                 | W,D   | Update/delete downtime.                                                                                       |

Secure credential values and private-location runtime keys never transit MCP.

## Workloads

| Tool                                                    | Flags | Purpose                                      |
| ------------------------------------------------------- | ----- | -------------------------------------------- |
| `workloads_list`, `workload_get`, `workload_status_get` | R     | List/read workloads and status.              |
| `workload_create`, `workload_duplicate`                 | W     | Create or duplicate a workload.              |
| `workload_update`, `workload_delete`                    | W,D   | Replace workload configuration or delete it. |

## Service levels

| Tool                                                     | Flags | Purpose                                      |
| -------------------------------------------------------- | ----- | -------------------------------------------- |
| `service_levels_list`, `service_level_get`               | R     | Read service-level indicator definitions.    |
| `service_level_results`                                  | R     | Run a bounded read-only result query.        |
| `maintenance_windows_list`                               | R     | Read maintenance windows by bounded ID list. |
| `service_level_create`                                   | W     | Create an SLI/objectives for an entity.      |
| `service_level_update`                                   | W,D   | Update an SLI/objectives.                    |
| `maintenance_window_create`                              | W     | Create a maintenance window.                 |
| `maintenance_window_update`, `maintenance_window_delete` | W,D   | Update/delete a maintenance window.          |

There is no `service_level_delete`; current public New Relic documentation does not
define a supported delete mutation.

## Log/data configuration

| Tool                                                   | Flags | Purpose                                                                         |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `log_configurations_list`                              | R     | List partitions, parsing rules, obfuscation expressions, and obfuscation rules. |
| `log_configuration_create`                             | W     | Create one discriminated configuration type.                                    |
| `log_configuration_update`, `log_configuration_delete` | W,D   | Update/delete the selected typed configuration.                                 |

The input discriminator is one of `partition`, `parsing_rule`,
`obfuscation_expression`, or `obfuscation_rule`; unrelated upstream input shapes are
not accepted.

## Metric/data management

| Tool                                                                    | Flags | Purpose                                                |
| ----------------------------------------------------------------------- | ----- | ------------------------------------------------------ |
| `metric_normalization_rules_list`, `pipeline_rules_list`                | R     | Read normalization and current Pipeline Control rules. |
| `metric_normalization_rule_create`, `metric_normalization_rule_update`  | W,D,P | Create/update a preview normalization rule.            |
| `metric_normalization_rule_enable`, `metric_normalization_rule_disable` | W,D,P | Enable/disable a preview normalization rule.           |
| `pipeline_rule_create`, `pipeline_rule_update`                          | W,D,P | Create/update a current Pipeline Control cloud rule.   |

These operations can suppress, reshape, or drop telemetry and are always preview
and destructive gated.

## Administration

All administration tools require `NEW_RELIC_ENABLE_ADMIN` and `newrelic:admin`.
Admin writes additionally require the write gate; rows marked **D** also require
the destructive gate.

| Tools                                                                                 | Flags | Purpose                                              |
| ------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| `organization_get`, `admin_resources_list`, `audit_events_query`                      | R,A   | Read organization metadata/resources/audit history.  |
| `users_list`, `groups_list`, `custom_roles_list`                                      | R,A   | Read identity and role metadata.                     |
| `access_grants_list`, `data_access_policies_list`, `api_keys_list`                    | R,A   | Read access and API-key metadata only.               |
| `account_create`, `account_update`                                                    | W,A   | Create or rename a managed account.                  |
| `account_cancel`                                                                      | W,D,A | Cancel a managed account.                            |
| `user_create`                                                                         | W,A   | Create a manually provisioned user.                  |
| `user_update`, `user_delete`                                                          | W,D,A | Update/delete a manually provisioned user.           |
| `group_create`, `group_update`                                                        | W,A   | Create/rename a manually provisioned group.          |
| `group_delete`                                                                        | W,D,A | Delete a group.                                      |
| `group_membership_add`                                                                | W,A   | Add users to groups.                                 |
| `group_membership_remove`                                                             | W,D,A | Remove users from groups.                            |
| `custom_role_create`                                                                  | W,A   | Create a custom role from documented permission IDs. |
| `custom_role_update`, `custom_role_delete`                                            | W,D,A | Replace/delete a custom role.                        |
| `access_grant_create`                                                                 | W,A   | Create an access grant.                              |
| `access_grant_delete`                                                                 | W,D,A | Revoke an access grant.                              |
| `data_access_policy_create`, `data_access_policy_update`, `data_access_policy_delete` | W,D,A | Manage log data access policy documents.             |
| `api_key_update`                                                                      | W,A   | Update key metadata only.                            |
| `api_key_delete`                                                                      | W,D,A | Revoke selected non-original keys by ID.             |

API-key creation is excluded because it returns secret key material.

## Resources

Resources are JSON and read-only:

- `newrelic://server/capabilities`
- `newrelic://accounts`
- `newrelic://entities/{guid}`
- `newrelic://dashboards/{guid}`
- `newrelic://alert-policies/{accountId}/{id}`
- `newrelic://synthetic-monitors/{guid}`
- `newrelic://workloads/{guid}`
- `newrelic://service-levels/{entityGuid}/{id}`

Template parameters receive the same validation/account checks as tools. Resources
do not bypass toolset or admin gates.

## Prompts

Static prompts provide sequencing guidance and never call New Relic by themselves:

- `incident_triage`
- `service_health`
- `alert_policy_review`
- `slo_review`
- `dashboard_design`
- `synthetic_failure_analysis`

Clients vary in prompt/resource support. Every required data action remains
available as an ordinary tool.
