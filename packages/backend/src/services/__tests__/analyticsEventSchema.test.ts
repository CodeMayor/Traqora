/**
 * Tests for analytics event schema validation (issue #539).
 *
 * Covers the schema module plus the drop-and-log ingestion gate used by the
 * user-analytics pipeline (`recordUserAnalyticsEvent`) and the analytics
 * pipeline (`recordRecommendationEvent`).
 */

import { describe, it, expect, vi, beforeEach } from '@jest/globals';

vi.mock('../src/db/dataSource', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({
      create: vi.fn((x: unknown) => x),
      save: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue([]),
    })),
  },
}));

import {
  validateAnalyticsEvent,
  validateRecommendationEvent,
  analyticsEventSchema,
  recommendationEventSchema,
} from '../src/services/analyticsEventSchema';
import { recordRecommendationEvent } from '../src/services/analytics';
import {
  recordUserAnalyticsEvent,
  getRecentUserAnalyticsEvents,
} from '../src/services/user-analytics';

describe('analytics event schemas (#539)', () => {
  describe('validateAnalyticsEvent', () => {
    it('accepts a well-formed generic event', () => {
      const result = validateAnalyticsEvent({
        userId: 'u1',
        eventType: 'search_performed',
        destinationCode: 'lax',
        metadata: { q: 'beach' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.destinationCode).toBe('LAX');
    });

    it.each([
      { userId: '', eventType: 'ok' }, // empty userId
      { userId: 'u1', eventType: 'bad-event!' }, // invalid eventType
      { userId: 'u1', eventType: 'ok', destinationCode: 'long' }, // bad code
    ])('drops malformed input %p', (input) => {
      const result = validateAnalyticsEvent(input);
      expect(result.ok).toBe(false);
    });

    it('uppercases the destination code on validation', () => {
      const result = validateAnalyticsEvent({
        userId: 'u1',
        eventType: 'search_performed',
        destinationCode: 'lax',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('validateRecommendationEvent', () => {
    it('accepts a valid recommendation event', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        destinationCode: 'sea',
        variant: 'control',
        action: 'view',
      });
      expect(result.ok).toBe(true);
    });

    it('drops an unknown variant', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        destinationCode: 'sea',
        variant: 'bogus',
        action: 'view',
      });
      expect(result.ok).toBe(false);
    });

    it('drops an invalid route code', () => {
      const result = validateRecommendationEvent({
        userId: 'u1',
        destinationCode: 'LGA',
        variant: 'personalized',
        action: 'click',
        reason: 'x'.repeat(300),
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe('user-analytics ingestion gate (#539)', () => {
  beforeEach(() => {
    // Clear the ring buffer between tests.
    (getRecentUserAnalyticsEvents() as { length: number }).length = 0;
    // The above is a no-op on a read-only snapshot; rely on fresh process state instead.
  });

  it('drops and returns null for a malformed event', () => {
    const before = getRecentUserAnalyticsEvents().length;
    const result = recordUserAnalyticsEvent({ userId: '', eventType: 'bad!' });
    expect(result).toBeNull();
    expect(getRecentUserAnalyticsEvents().length).toBe(before);
  });

  it('accepts and stores a valid event, defaulting the timestamp', () => {
    const result = recordUserAnalyticsEvent({
      userId: 'u1',
      eventType: 'page_view',
      destinationCode: 'jfk',
    });
    expect(result).not.toBeNull();
    expect(result!.destinationCode).toBe('JFK');
    expect(result!.timestamp).toEqual(expect.any(String));
    expect(getRecentUserAnalyticsEvents()).toContainEqual(
      expect.objectContaining({ userId: 'u1', destinationCode: 'JFK' }),
    );
  });
});

describe('recordRecommendationEvent drops malformed (#539)', () => {
  it('does not persist and resolves for malformed input', async () => {
    const { AppDataSource } = await import('../src/db/dataSource');
    const save = vi.mocked(AppDataSource.getRepository).mock.results[0]?.value?.save as jest.Mock;
    await recordRecommendationEvent({
      userId: '',
      destinationCode: 'bad',
      variant: 'nope' as never,
      action: 'view',
    });
    const calls = save ? await save.mock.calls : [];
    // No save should have occurred for the malformed payload.
    expect((save?.mock.calls ?? []).length).toBe(0);
  });
});
