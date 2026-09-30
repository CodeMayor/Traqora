/**
 * Tests for analytics event schema validation (issue #539).
 *
 * Follows the repo's unit-test style (see VolatilityService.test.ts):
 * pure functions only, no live DB. The schema validators — the core of the
 * "validate before the pipeline" requirement — are exercised in isolation.
 */

import { describe, it, expect } from '@jest/globals';

import {
  validateAnalyticsEvent,
  validateRecommendationEvent,
  analyticsEventSchema,
  recommendationEventSchema,
} from '../analyticsEventSchema';

describe('analytics event schemas (#539)', () => {
  describe('analyticsEventSchema', () => {
    it('accepts a well-formed generic event', () => {
      const parsed = analyticsEventSchema.safeParse({
        userId: 'u1',
        eventType: 'search_performed',
        destinationCode: 'lax',
        metadata: { q: 'beach' },
      });
      expect(parsed.success).toBe(true);
    });

    it('requires a non-empty userId', () => {
      expect(analyticsEventSchema.safeParse({ userId: '', eventType: 'ok' }).success).toBe(false);
    });

    it('requires a lowercase event type with alphanumeric/underscore chars', () => {
      expect(analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'bad-type!' }).success).toBe(false);
      expect(analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok' }).success).toBe(true);
    });

        it('requires a 3-letter destination code when provided', () => {
      // 3 letters, any case, are accepted (the gate normalises to uppercase).
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'JFK' }).success,
      ).toBe(true);
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'lax' }).success,
      ).toBe(true);
      // Wrong length / non-alpha are rejected.
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'LONG' }).success,
      ).toBe(false);
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'LAX1' }).success,
      ).toBe(false);
    });

    it('accepts arbitrary metadata (open record)', () => {
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', metadata: { anything: 1 } }).success,
      ).toBe(true);
    });
  });

  describe('recommendationEventSchema', () => {
    it('accepts the known variant/action matrix', () => {
      for (const variant of ['control', 'personalized'] as const) {
        for (const action of ['view', 'click', 'dismiss'] as const) {
          expect(
            recommendationEventSchema.safeParse({
              userId: 'u1',
              destinationCode: 'sea',
              variant,
              action,
            }).success,
          ).toBe(true);
        }
      }
    });

    it('rejects an unknown variant', () => {
      expect(
        recommendationEventSchema.safeParse({
          userId: 'u1',
          destinationCode: 'sea',
          variant: 'bogus',
          action: 'view',
        }).success,
      ).toBe(false);
    });

    it('rejects an invalid action', () => {
      expect(
        recommendationEventSchema.safeParse({
          userId: 'u1',
          destinationCode: 'sea',
          variant: 'control',
          action: 'fly',
        }).success,
      ).toBe(false);
    });

    it('rejects a non-3-letter destination with an over-long reason', () => {
      const reason = 'x'.repeat(300);
      expect(
        recommendationEventSchema.safeParse({
          userId: 'u1',
          destinationCode: 'LGA',
          variant: 'personalized',
          action: 'click',
          reason,
        }).success,
      ).toBe(false);
    });

    it('makes reason optional', () => {
      expect(
        recommendationEventSchema.safeParse({
          userId: 'u1',
          destinationCode: 'sea',
          variant: 'control',
          action: 'view',
        }).success,
      ).toBe(true);
    });
  });
});

describe('validators (#539)', () => {
  describe('validateAnalyticsEvent', () => {
    it('returns a success result with the parsed event for valid input', () => {
      const result = validateAnalyticsEvent({ userId: 'u1', eventType: 'a' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.userId).toBe('u1');
    });

    it('returns a failure result with errors for invalid input', () => {
      const result = validateAnalyticsEvent({ userId: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateRecommendationEvent', () => {
    it('returns the parsed event for valid input', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        destinationCode: 'sea',
        variant: 'control',
        action: 'view',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.variant).toBe('control');
    });

    it('rejects a missing destination code', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        variant: 'control',
        action: 'view',
      });
      expect(result.ok).toBe(false);
    });
  });
});
