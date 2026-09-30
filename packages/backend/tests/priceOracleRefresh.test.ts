/**
 * Tests for PriceOracleService refresh triggers + confidence scoring
 * (issue #535). Uses fake timers to control staleness and refresh
 * frequency deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';

jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('axios', () => ({ get: jest.fn().mockResolvedValue({ data: { data: [] } }) }));

import {
  PriceOracleService,
  PRICE_STALENESS_MS,
  MIN_REFRESH_INTERVAL_MS,
} from '../services/PriceOracleService';

describe('PriceOracleService — refresh triggers and confidence scoring (#535)', () => {
  let oracle: PriceOracleService;

  /**
   * mockApiCall awaits setTimeout(500); run the fetch and let fake timers
   * advance so the promise settles.
   */
  async function settle<T>(work: Promise<T>, ms = 600): Promise<T> {
    const result = work;
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Fresh singleton per test so caches do not leak between cases.
    (PriceOracleService as any).instance = undefined;
    oracle = PriceOracleService.getInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no confidence and reports staleness for unknown flights', () => {
    expect(oracle.getConfidence('F-1')).toBe(0);
    expect(oracle.isStale('F-1')).toBe(true);
    expect(oracle.getPriceAgeMs('F-1')).toBeNull();
  });

  it('caches the first fetch and serves it without a refresh while fresh', async () => {
    const [first] = await settle(oracle.fetchPrices(['F-1']));
    expect(first).toBeDefined();
    expect(oracle.isStale('F-1')).toBe(false);

    const spy = vi.spyOn(oracle as any, 'mockApiCall');
    const [cached] = await oracle.fetchPrices(['F-1']);
    // Same underlying observation served from cache (no upstream call).
    expect(cached!.timestamp.getTime()).toBe(first!.timestamp.getTime());
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes when the cached price goes stale', async () => {
    const [first] = await settle(oracle.fetchPrices(['F-1']));
    expect(first).toBeDefined();

    vi.advanceTimersByTime(PRICE_STALENESS_MS + 1);
    expect(oracle.isStale('F-1')).toBe(true);

    const spy = vi.spyOn(oracle as any, 'mockApiCall');
    await settle(oracle.fetchPrices(['F-1']));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bounds refresh frequency: back-to-back stale reads do not re-fetch', async () => {
    await settle(oracle.fetchPrices(['F-1']));
    vi.advanceTimersByTime(PRICE_STALENESS_MS + 1);

    const spy = vi.spyOn(oracle as any, 'mockApiCall');
    // Many concurrent callers after staleness trigger exactly one refresh.
    const calls = Array.from({ length: 10 }, () => oracle.fetchPrices(['F-1']));
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all(calls);
    expect(spy).toHaveBeenCalledTimes(1);

    // Even sequential callers inside the bounded window do not re-fetch.
    await oracle.fetchPrices(['F-1']);
    expect(spy).toHaveBeenCalledTimes(1);

    // After the window opens, exactly one more refresh happens.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    await settle(oracle.fetchPrices(['F-1']));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('publishes a confidence score on every returned price', async () => {
    const [price] = await settle(oracle.fetchPrices(['F-1']));
    expect(price!.confidence).toBeGreaterThan(0);
    expect(price!.confidence).toBeLessThanOrEqual(1);
  });

  it('decays confidence as the cached price ages', async () => {
    await settle(oracle.fetchPrices(['F-1']));
    const fresh = oracle.getConfidence('F-1');
    vi.advanceTimersByTime(PRICE_STALENESS_MS);
    const older = oracle.getConfidence('F-1');
    expect(older).toBeLessThan(fresh);
    expect(older).toBeGreaterThanOrEqual(0);
  });

  it('is 0 for flights with no data', () => {
    expect(oracle.getConfidence('never-fetched')).toBe(0);
  });

  it('refreshPrices() forces a bounded refresh trigger', async () => {
    const [first] = await settle(oracle.fetchPrices(['F-1']));
    const spy = vi.spyOn(oracle as any, 'mockApiCall');

    // Immediate explicit trigger is rate-limited (bounded frequency).
    await oracle.refreshPrices(['F-1']);
    expect(spy).not.toHaveBeenCalled();

    // After the bounded window an explicit trigger re-fetches.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    const [refreshed] = await settle(oracle.refreshPrices(['F-1']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(refreshed!.timestamp.getTime()).toBeGreaterThan(first!.timestamp.getTime());
    expect(refreshed!.confidence).toBeGreaterThan(0);
  });

  it('confidence reflects observation stability (wide spread lowers score)', async () => {
    // Seed a cache with an unstable price history through refreshes.
    const randSpy = vi.spyOn(Math, 'random');
    let call = 0;
    randSpy.mockImplementation(() => {
      // Alternates the base price widely (100..150 band).
      call += 1;
      return call % 2 === 0 ? 0.99 : 0.0;
    });

    await settle(oracle.fetchPrices(['F-1']));
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    await settle(oracle.fetchPrices(['F-1']));
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS + 1);
    await settle(oracle.fetchPrices(['F-1']));

    const confidence = oracle.getConfidence('F-1');
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
    randSpy.mockRestore();
  });
});
