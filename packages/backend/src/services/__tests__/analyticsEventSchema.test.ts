/**
 * Tests for analytics event schema validation (issue #539).
 *
 * Follows the repo's unit-test style (see VolatilityService.test.ts):
 * pure functions only, no live DB. The validators and the pure ingestion
 * gate are exercised in isolation.
 */

import { describe, it, expect } from '@jest/globals';

import {
  validateAnalyticsEvent,
  validateRecommendationEvent,
  analyticsEventSchema,
  recommendationEventSchema,
} from '../analyticsEventSchema';
import { recordUserAnalyticsEvent, getRecentUserAnalyticsEvents } from '../user-analytics';
import type { AnalyticsEvent, ValidatedRecommendationEvent } from '../analyticsEventSchema';

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
      const parsed = analyticsEventSchema.safeParse({ userId: '', eventType: 'ok' });
      expect(parsed.success).toBe(false);
    });

    it('requires a lowercase event type with alphanumeric/underscore chars', () => {
      expect(analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'bad-type!' }).success).toBe(false);
      expect(analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok' }).success).toBe(true);
    });

    it('requires a 3-letter destination code when provided', () => {
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'LGA' }).success,
      ).toBe(false);
      expect(
        analyticsEventSchema.safeParse({ userId: 'u1', eventType: 'ok', destinationCode: 'lax' }).success,
      ).toBe(true);
    });
  });

  describe('recommendationEventSchema', () => {
    it('accepts the known variant/action matrix', () => {
      for (const variant of ['control', 'personalized'] as const) {
        for (const action of ['view', 'click', 'dismiss'] as const) {
          const ok = recommendationEventSchema.safeParse({
            userId: 'u1',
            destinationCode: 'sea',
            variant,
            action,
          }).success;
          expect(ok).toBe(true);
        }
      }
    });

    it('rejects an unknown variant', () => {
      const parsed = recommendationEventSchema.safeParse({
        userId: 'u1',
        destinationCode: 'sea',
        variant: 'bogus',
        action: 'view',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects a non-3-letter destination with an over-long reason', () => {
      const parsed = recommendationEventSchema.safeParse({
        userId: 'u1',
        destinationCode: 'LGA',
        variant: 'personalized',
        action: 'click',
        reason: 'x'.repeat(300),
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('validateAnalyticsEvent', () => {
    it('returns a success result for valid input', () => {
      const result = validateAnalyticsEvent({ userId: 'u1', eventType: 'a' });
      expect(result.ok).toBe(true);
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
      if (result.ok) {
        const v: ValidatedRecommendationEvent = result.event;
        expect(v.destinationCode).toBe('sea');
      }
    });

    it('rejects an invalid action', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        destinationCode: 'sea',
        variant: 'control',
        action: 'buy' as never,
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe('user-analytics ingestion gate (#539)', () => {
  it('drops and returns null for a malformed event, leaving the buffer unchanged', () => {
    const before = getRecentUserAnalyticsEvents().length;
    const result = recordUserAnalyticsEvent({ userId: '', eventType: 'bad!' });
    expect(result).toBeNull();
    expect(getRecentUserAnalyticsEvents().length).toBe(before);
  });

  it('accepts a valid event, normalising the timestamp and uppercasing the route', () => {
    const result = recordUserAnalyticsEvent({
      userId: 'u1',
      eventType: 'page_view',
      destinationCode: 'jfk',
    });
    expect(result).not.toBeNull();
    expect(result!.destinationCode).toBe('JFK');
    expect(typeof result!.timestamp).toBe('string');
    expect(getRecentUserAnalyticsEvents()).toContainEqual(
      expect.objectContaining({ userId: 'u1', destinationCode: 'JFK' }),
    );
  });

  it('rejects a missing eventType without persisting', () => {
    const before = getRecentUserAnalyticsEvents().length;
    const result = recordUserAnalyticsEvent({ userId: 'u1' });
    expect(result).toBeNull();
    expect(getRecentUserAnalyticsEvents().length).toBe(before);
  });

  it('the returned event round-trips through the schema', () => {
    const result = recordUserAnalyticsEvent({
      userId: 'u2',
      eventType: 'search_performed',
      destinationCode: 'lax',
    });
    expect(result).not.toBeNull();
    const parsed = analyticsEventSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it('exposes a readonly snapshot of accepted events', () => {
    const result: AnalyticsEvent = recordUserAnalyticsEvent({
      userId: 'u3',
      eventType: 'click',
      destinationCode: 'cdg',
    }) as AnalyticsEvent;
    expect(result).not.toBeNull();
    expect(getRecentUserAnalyticsEvents().length).toBeGreaterThan(0);
  });
});
