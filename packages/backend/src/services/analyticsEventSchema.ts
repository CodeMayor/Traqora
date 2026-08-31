/**
 * Analytics event schema validation (issue #539).
 *
 * Every analytics event entering the user-analytics and analytics
 * pipelines is validated against these zod schemas before being recorded.
 * Malformed events are dropped and logged by the callers rather than
 * silently processed or persisted.
 */

import { z } from 'zod';

export const RECOMMENDATION_VARIANTS = ['control', 'personalized'] as const;
export const RECOMMENDATION_ACTIONS = ['view', 'click', 'dismiss'] as const;

/**
 * Generic analytics event envelope shared by the user-analytics pipeline.
 * `eventType` discriminates the payload; `metadata` is an open bag capped
 * in size to keep oversized payloads out of the pipeline.
 */
export const analyticsEventSchema = z.object({
  /** Non-empty identifier of the user that generated the event. */
  userId: z.string().trim().min(1).max(128),
  /** Machine-readable event name, e.g. `search_performed`. */
  eventType: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  /** ISO-8601 timestamp; defaults to "now" when absent. */
  timestamp: z.string().datetime().optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  destinationCode: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Za-z]{3}$/, 'destinationCode must be a 3-letter airport code')
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** Schema for recommendation analytics events (services/analytics pipeline). */
export const recommendationEventSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  destinationCode: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Za-z]{3}$/, 'destinationCode must be a 3-letter airport code'),
  variant: z.enum(RECOMMENDATION_VARIANTS),
  action: z.enum(RECOMMENDATION_ACTIONS),
  reason: z.string().trim().max(256).optional(),
});

export type ValidatedRecommendationEvent = z.infer<typeof recommendationEventSchema>;

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export interface ValidationSuccess<T> {
  ok: true;
  event: T;
}

/**
 * Validates a raw (untrusted) payload against the generic analytics event
 * schema. Returns a discriminated result so callers can drop + log.
 */
export function validateAnalyticsEvent(
  input: unknown,
): ValidationSuccess<AnalyticsEvent> | ValidationFailure {
  const result = analyticsEventSchema.safeParse(input);
  if (result.success) {
    return { ok: true, event: result.data };
  }
  return { ok: false, errors: flattenIssues(result.error) };
}

/**
 * Validates a raw payload as a recommendation analytics event.
 * Returns a discriminated result so callers can drop + log.
 */
export function validateRecommendationEvent(
  input: unknown,
): ValidationSuccess<ValidatedRecommendationEvent> | ValidationFailure {
  const result = recommendationEventSchema.safeParse(input);
  if (result.success) {
    return { ok: true, event: result.data };
  }
  return { ok: false, errors: flattenIssues(result.error) };
}

function flattenIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}
