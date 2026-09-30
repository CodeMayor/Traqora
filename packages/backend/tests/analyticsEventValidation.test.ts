/**
 * Tests for analytics event schema validation (issue #539).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

const warn = jest.fn();
jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() },
}));

const save = jest.fn().mockResolvedValue(undefined);
const create = jest.fn((x: unknown) => x);
jest.mock('../src/db/dataSource', () => ({
  AppDataSource: {
    getRepository: jest.fn(() => ({ create, save })),
  },
}));

import { validateAnalyticsEvent, validateRecommendationEvent } from '../src/services/analyticsEventSchema';
import { recordRecommendationEvent } from '../src/services/analytics';
import { recordUserAnalyticsEvent } from '../src/services/user-analytics';

const validRecommendation = {
  userId: 'user-1',
  destinationCode: 'LAX',
  variant: 'personalized' as const,
  action: 'view' as const,
};

describe('analytics event schema validation (#539)', () => {
  beforeEach(() => {
    warn.mockClear();
    save.mockClear();
    create.mockClear();
  });

  describe('validateAnalyticsEvent', () => {
    it('accepts a well-formed event', () => {
      const result = validateAnalyticsEvent({
        userId: 'u1',
        eventType: 'search_performed',
      });
      expect(result.ok).toBe(true);
    });

    it('rejects empty userId and bad eventType shapes', () => {
      for (const bad of [
        { userId: '', eventType: 'search_performed' },
        { userId: 'u1', eventType: 'Not snake_case!' },
        { userId: 'u1', eventType: 'search_performed', destinationCode: 'TOOLONG' },
        {},
        null,
        'string',
      ]) {
        const result = validateAnalyticsEvent(bad);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('rejects non-ISO timestamps', () => {
      const result = validateAnalyticsEvent({
        userId: 'u1',
        eventType: 'search_performed',
        timestamp: 'yesterday',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('validateRecommendationEvent', () => {
    it('accepts valid variant/action combinations', () => {
      expect(validateRecommendationEvent(validRecommendation).ok).toBe(true);
      expect(
        validateRecommendationEvent({ ...validRecommendation, action: 'click', reason: 'x' }).ok,
      ).toBe(true);
    });

    it('rejects unknown variants, actions, and bad airport codes', () => {
      expect(validateRecommendationEvent({ ...validRecommendation, variant: 'champion' }).ok).toBe(false);
      expect(validateRecommendationEvent({ ...validRecommendation, action: 'hover' }).ok).toBe(false);
      expect(validateRecommendationEvent({ ...validRecommendation, destinationCode: 'LAXX' }).ok).toBe(false);
    });
  });

  describe('recordRecommendationEvent drops malformed events', () => {
    it('does not persist a malformed event and logs the drop', async () => {
      await recordRecommendationEvent({
        ...validRecommendation,
        variant: 'bogus' as never,
      });
      expect(save).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'analytics: dropped malformed recommendation event',
        expect.objectContaining({ errors: expect.any(Array) }),
      );
    });

    it('still persists valid events (behaviour preserved, code uppercased)', async () => {
      await recordRecommendationEvent({ ...validRecommendation, destinationCode: 'lax' });
      expect(save).toHaveBeenCalledTimes(1);
      expect((create.mock.calls[0][0] as any).destinationCode).toBe('LAX');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('recordUserAnalyticsEvent drops malformed events', () => {
    it('returns null and logs for malformed payloads', () => {
      expect(recordUserAnalyticsEvent({ userId: '', eventType: 'x' })).toBeNull();
      expect(recordUserAnalyticsEvent(undefined)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('accepts and normalises valid events', () => {
      const event = recordUserAnalyticsEvent({
        userId: 'u1',
        eventType: 'search_performed',
        destinationCode: 'sfo',
      });
      expect(event).not.toBeNull();
      expect(event!.destinationCode).toBe('SFO');
      expect(event!.timestamp).toBeTruthy();
    });
  });
});
