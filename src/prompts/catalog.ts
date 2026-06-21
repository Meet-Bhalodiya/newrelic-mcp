import { z, type ZodObject, type ZodRawShape } from 'zod';

export interface PromptMessage {
  readonly role: 'user';
  readonly content: { readonly type: 'text'; readonly text: string };
}

export interface PromptDefinition<Shape extends ZodRawShape = ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly argumentsSchema: ZodObject<Shape>;
  readonly get: (arguments_: unknown) => { readonly messages: readonly PromptMessage[] };
}

function prompt<Shape extends ZodRawShape>(options: {
  name: string;
  title: string;
  description: string;
  argumentsSchema: ZodObject<Shape>;
  text: (arguments_: z.output<ZodObject<Shape>>) => string;
}): PromptDefinition<Shape> {
  return {
    ...options,
    get: (rawArguments) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: options.text(options.argumentsSchema.parse(rawArguments)),
          },
        },
      ],
    }),
  };
}

const accountId = z.coerce.number().int().positive().optional();
const entityGuid = z.string().min(1).max(128).optional();

export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = Object.freeze([
  prompt({
    name: 'incident_triage',
    title: 'Triage a New Relic incident',
    description:
      'Collect a bounded evidence set for an active issue or incident and propose next actions.',
    argumentsSchema: z
      .object({
        accountId,
        issueId: z.string().max(512).optional(),
        serviceName: z.string().max(255).optional(),
        lookback: z.string().max(64).default('2 hours'),
      })
      .strict(),
    text: ({ accountId, issueId, serviceName, lookback }) =>
      `Triage the New Relic incident${issueId ? ` ${issueId}` : ''}${serviceName ? ` affecting ${serviceName}` : ''}${accountId ? ` in account ${accountId}` : ''}. Use a ${lookback} lookback. Start with issues/incidents and related entities, then correlate errors, logs, metrics, and traces. State evidence, uncertainty, likely blast radius, and prioritized mitigations. Do not mutate anything unless I explicitly request it; if I do, run the tool's dry-run first and show its exact diff and confirmation phrase.`,
  }),
  prompt({
    name: 'service_health',
    title: 'Assess service health',
    description: "Review an entity's golden signals, errors, logs, traces, alerts, and SLO state.",
    argumentsSchema: z
      .object({
        accountId,
        entityGuid,
        serviceName: z.string().max(255).optional(),
        lookback: z.string().max(64).default('1 hour'),
      })
      .strict(),
    text: ({ accountId, entityGuid, serviceName, lookback }) =>
      `Assess current health for ${serviceName ?? entityGuid ?? 'the specified service'}${accountId ? ` in account ${accountId}` : ''} over ${lookback}. Resolve the entity first, then examine golden metrics, alert state, errors, logs, representative traces, workload state, and service-level results. Distinguish observed facts from hypotheses and finish with a concise risk summary.`,
  }),
  prompt({
    name: 'alert_policy_review',
    title: 'Review alert policy quality',
    description:
      'Audit policies and conditions for coverage, noise, unsafe gaps, and maintainability.',
    argumentsSchema: z.object({ accountId, policyId: z.string().max(512).optional() }).strict(),
    text: ({ accountId, policyId }) =>
      `Review New Relic alert policy${policyId ? ` ${policyId}` : ' inventory'}${accountId ? ` in account ${accountId}` : ''}. Inspect policy preferences, NRQL conditions, thresholds, evaluation windows, loss-of-signal behavior, runbooks, muting rules, workflows, and destinations. Identify noisy, duplicate, disabled, overly broad, and missing coverage. Recommend changes only; do not apply them unless explicitly requested and confirmed after dry-run.`,
  }),
  prompt({
    name: 'slo_review',
    title: 'Review service levels',
    description:
      'Assess SLI definitions, objective windows, attainment, and maintenance-window effects.',
    argumentsSchema: z
      .object({
        accountId,
        entityGuid,
        serviceLevelId: z.string().max(512).optional(),
        lookback: z.string().max(64).default('28 days'),
      })
      .strict(),
    text: ({ accountId, entityGuid, serviceLevelId, lookback }) =>
      `Review service-level configuration${serviceLevelId ? ` ${serviceLevelId}` : ''}${entityGuid ? ` for entity ${entityGuid}` : ''}${accountId ? ` in account ${accountId}` : ''}. Evaluate validity and representativeness of valid/good/bad event definitions, objective targets and windows, attainment over ${lookback}, error-budget risk, and maintenance windows. Do not invent or propose a service-level delete operation.`,
  }),
  prompt({
    name: 'dashboard_design',
    title: 'Design a New Relic dashboard',
    description: 'Design or review a dashboard using bounded, readable NRQL widgets.',
    argumentsSchema: z
      .object({
        accountId,
        audience: z.string().max(255).default('service operators'),
        objective: z.string().min(1).max(1000),
        existingDashboardGuid: z.string().max(128).optional(),
      })
      .strict(),
    text: ({ accountId, audience, objective, existingDashboardGuid }) =>
      `Design a New Relic dashboard for ${audience} with this objective: ${objective}.${accountId ? ` Use account ${accountId}.` : ''}${existingDashboardGuid ? ` Review dashboard ${existingDashboardGuid} before proposing edits.` : ''} Prefer a small number of decision-oriented pages, consistent time windows, clear units, bounded NRQL, and golden-signal/SLO context. If implementation is requested, use dry-run; dashboard updates replace omitted content, so preserve intended pages, widgets, and variables.`,
  }),
  prompt({
    name: 'synthetic_failure_analysis',
    title: 'Analyze a synthetic failure',
    description:
      'Correlate a failing monitor with locations, downtime, service signals, logs, and traces.',
    argumentsSchema: z
      .object({
        accountId,
        monitorGuid: z.string().min(1).max(128),
        lookback: z.string().max(64).default('2 hours'),
      })
      .strict(),
    text: ({ accountId, monitorGuid, lookback }) =>
      `Analyze failures for synthetic monitor ${monitorGuid}${accountId ? ` in account ${accountId}` : ''} over ${lookback}. Inspect monitor metadata, public/private locations, planned downtime, result patterns, affected service entities, errors, logs, and traces. Never request or expose secure credential values or embedded secrets. Separate location-specific failures from application-wide failures and recommend the smallest safe next diagnostic step.`,
  }),
]);

export function buildPromptDefinitions(): readonly PromptDefinition[] {
  return PROMPT_DEFINITIONS;
}
