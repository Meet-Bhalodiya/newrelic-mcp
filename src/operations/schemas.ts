import { z } from 'zod';

import { assertReadOnlyNrql, nrqlControlText } from '../security/nrql.js';

export const accountIdSchema = z.number().int().positive().describe('New Relic account ID');
export const guidSchema = z.string().min(1).max(128).describe('New Relic entity GUID');
export const cursorSchema = z.string().min(1).max(8192);

export const graphQlDataSchema = z.record(z.string(), z.unknown());

export const actorEnvelopeSchema = z.object({
  actor: z.record(z.string(), z.unknown()),
});

export const entitySummarySchema = z.object({
  guid: guidSchema,
  name: z.string(),
  domain: z.string().nullish(),
  type: z.string().nullish(),
  accountId: accountIdSchema.nullish(),
  alertSeverity: z.string().nullish(),
  reporting: z.boolean().nullish(),
  tags: z
    .array(
      z.object({
        key: z.string(),
        values: z.array(z.string()),
      }),
    )
    .nullish(),
});

export const writeControlsSchema = {
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'Preview the change. Applying a change requires dryRun=false and the returned confirmation phrase.',
    ),
  confirmation: z
    .string()
    .max(256)
    .optional()
    .describe('Exact phrase returned by a dry-run using identical arguments'),
};

function nrqlIssue(
  context: z.core.$RefinementCtx<unknown>,
  path: PropertyKey[],
  error: unknown,
): void {
  context.addIssue({
    code: 'custom',
    path,
    message: error instanceof Error ? error.message : 'NRQL must be read-only',
  });
}

/** Validate embedded configuration NRQL without rewriting it or adding a LIMIT. */
export const readOnlyConfigurationNrqlSchema = z
  .string()
  .min(1)
  .max(16_384)
  .superRefine((value, context) => {
    try {
      assertReadOnlyNrql(value);
    } catch (error) {
      nrqlIssue(context, [], error);
    }
  });

/**
 * Pipeline Control is the only public surface that intentionally accepts DELETE
 * NRQL. It still accepts exactly one statement and rejects read or mixed input.
 */
export const pipelineDeleteNrqlSchema = z
  .string()
  .min(1)
  .max(16_384)
  .superRefine((value, context) => {
    try {
      const normalized = value.trim();
      if (/--|\/\*/u.test(normalized)) {
        throw new Error('Pipeline rules do not permit NRQL comments');
      }
      const control = nrqlControlText(normalized);
      if (control.includes(';')) throw new Error('Multiple NRQL statements are not allowed');
      const tokens = control.toUpperCase().match(/[A-Z_][A-Z0-9_]*/gu) ?? [];
      if (tokens[0] !== 'DELETE' || tokens.filter((token) => token === 'DELETE').length !== 1) {
        throw new Error('Pipeline rules require exactly one DELETE NRQL statement');
      }
      const forbiddenControlTokens = new Set([
        'ALTER',
        'CALL',
        'CREATE',
        'DROP',
        'EXEC',
        'EXECUTE',
        'GRANT',
        'INSERT',
        'MERGE',
        'REPLACE',
        'REVOKE',
        'SELECT',
        'TRUNCATE',
        'UPDATE',
        'UPSERT',
      ]);
      if (tokens.some((token) => forbiddenControlTokens.has(token))) {
        throw new Error('Pipeline rules require exactly one DELETE NRQL statement');
      }
    } catch (error) {
      nrqlIssue(context, [], error);
    }
  });

function validateNrqlQueries(
  value: unknown,
  context: z.core.$RefinementCtx<unknown>,
  path: PropertyKey[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateNrqlQueries(child, context, [...path, index]));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (key === 'nrqlQueries' && Array.isArray(child)) {
      child.forEach((queryDefinition, index) => {
        if (queryDefinition === null || typeof queryDefinition !== 'object') return;
        const query = (queryDefinition as Record<string, unknown>).query;
        if (typeof query !== 'string') return;
        const parsed = readOnlyConfigurationNrqlSchema.safeParse(query);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            context.addIssue({
              code: 'custom',
              path: [...childPath, index, 'query', ...issue.path],
              message: issue.message,
            });
          }
        }
      });
    }
    validateNrqlQueries(child, context, childPath);
  }
}

/** Add read-only checks to dashboard widget `rawConfiguration.nrqlQueries` fields. */
export function validateDashboardNrql(
  value: unknown,
  context: z.core.$RefinementCtx<unknown>,
): void {
  validateNrqlQueries(value, context);
}

export const dashboardInputSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).optional(),
    permissions: z.enum(['PRIVATE', 'PUBLIC_READ_ONLY', 'PUBLIC_READ_WRITE']),
    pages: z.array(z.record(z.string(), z.unknown())).min(1),
    variables: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict()
  .superRefine(validateDashboardNrql);

export const logConfigurationInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('partition'),
      description: z.string().max(1000).optional(),
      enabled: z.boolean(),
      matchingCriteria: z
        .object({
          attributeName: z.string().min(1).max(255),
          matchingExpression: z.string().min(1).max(16_384),
          matchingMethod: z.string().min(1).max(64),
        })
        .strict()
        .optional(),
      nrql: readOnlyConfigurationNrqlSchema.optional(),
      retentionPolicy: z.enum(['STANDARD', 'SECONDARY']),
      targetDataPartition: z.string().regex(/^Log_[A-Za-z0-9_]+$/u),
    })
    .strict(),
  z
    .object({
      type: z.literal('parsing_rule'),
      attribute: z.string().min(1).max(255).optional(),
      description: z.string().max(1000),
      enabled: z.boolean(),
      grok: z.string().min(1).max(32_768),
      lucene: z.string().min(1).max(16_384),
      nrql: readOnlyConfigurationNrqlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('obfuscation_expression'),
      name: z.string().min(1).max(255),
      description: z.string().max(1000).optional(),
      regex: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal('obfuscation_rule'),
      name: z.string().min(1).max(255),
      description: z.string().max(1000).optional(),
      enabled: z.boolean(),
      filter: z.string().min(1).max(16_384),
      actions: z
        .array(
          z
            .object({
              attributes: z.array(z.string().min(1)).max(100),
              expressionId: z.string().min(1),
              method: z.enum(['HASH_SHA256', 'MASK']),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
]);

export const metricNormalizationInputSchema = z
  .object({
    action: z.enum(['REPLACE', 'IGNORE', 'DENY_NEW_METRICS']),
    applicationGuid: guidSchema.optional(),
    enabled: z.boolean(),
    evalOrder: z.number().int().min(1),
    matchExpression: z
      .string()
      .min(2)
      .max(16_384)
      .refine(
        (value) => value.startsWith('^') && value.endsWith('$'),
        'matchExpression must be anchored',
      ),
    notes: z.string().max(4000).optional(),
    replacement: z.string().max(16_384).optional(),
    terminateChain: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'REPLACE' && !value.replacement) {
      context.addIssue({
        code: 'custom',
        path: ['replacement'],
        message: 'replacement is required for REPLACE',
      });
    }
  });
