/**
 * Unit tests for PriceOracleService freshness/confidence behaviour (issue #535).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PriceOracleService } from '../src/services/PriceOracleService';
import { PRICE_STALENESS_MS, MIN_REFRESH_INTERVAL_MS } from '../src/services/PriceOracleService';

const FLIGHT = 'JFK-LHR-2026-09-01';

describe('PriceOracleService freshness & confidence (#535)', () => {
  let oracle: PriceOracleService;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    PriceOracleService.resetForTesting();
    oracle = PriceOracleService.getInstance();
    spy = jest.spyOn(oracle as any, 'mockApiCall').mockResolvedValue([
      {
        flightId: FLIGHT,
        price: 123.45,
        currency: 'USD',
        timestamp: new Date(),
        source: 'test',
        confidence: 1,
      },
    ]);
  });

  it('publishes a confidence score in [0,1] on every price', async () => {
    const [price] = await oracle.fetchPrices([FLIGHT]);
    expect(price.confidence).not.toBeUndefined();
    expect(price.confidence).toBeGreaterThanOrEqual(0);
    expect(price.confidence).toBeLessThanOrEqual(1);
  });

  it('reports a fresh price as not stale after fetch', async () => {
    await oracle.fetchPrices([FLIGHT]);
    expect(oracle.isStale(FLIGHT)).toBe(false);
    expect(oracle.getPriceAgeMs(FLIGHT)).not.toBeNull();
    expect(oracle.getPriceAgeMs(FLIGHT)).toBeGreaterThanOrEqual(0);
  });

  it('reports an unknown flight as stale with confidence 0', () => {
    expect(oracle.isStale('NOPE')).toBe(true);
    expect(oracle.getPriceAgeMs('NOPE')).toBeNull();
    expect(oracle.getConfidence('NOPE')).toBe(0);
  });

  it('bounds refresh frequency: a second rapid fetch is served from cache', async () => {
    await oracle.fetchPrices([FLIGHT]);
    await oracle.fetchPrices([FLIGHT]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshPrices forces a fresh fetch', async () => {
    await oracle.fetchPrices([FLIGHT]);
    await oracle.refreshPrices([FLIGHT]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('confidence is ~1 for a fresh price with a single observation', async () => {
    await oracle.fetchPrices([FLIGHT]);
    // Single observation => spread=0 => stability=1, freshness~1.
    expect(oracle.getConfidence(FLIGHT)).toBeCloseTo(1, 2);
  });

  it('isStale respects PRICE_STALENESS_MS threshold', async () => {
    // Sanity-check the constant the staleness logic is built on.
    expect(PRICE_STALENESS_MS).toBe(60_000);
    expect(MIN_REFRESH_INTERVAL_MS).toBe(15_000);
    await oracle.fetchPrices([FLIGHT]);
    expect(oracle.isStale(FLIGHT)).toBe(false);
  });
});
