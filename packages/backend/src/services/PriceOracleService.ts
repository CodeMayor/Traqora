import { logger } from '../utils/logger';
import axios from 'axios';

// Supported currencies
export type SupportedCurrency = 'USD' | 'EUR' | 'GBP' | 'XLM' | 'USDC' | 'USDT';

export interface CurrencyRate {
  currency: SupportedCurrency;
  rate: number; // Rate relative to USD base
  timestamp: Date;
}

export interface FlightPrice {
  flightId: string;
  price: number;
  currency: string;
  timestamp: Date;
  source: string;
  /**
   * Confidence score in [0, 1] published alongside every price (issue #535).
   * Reflects data freshness and observation stability so downstream
   * predictions can flag uncertainty.
   */
  confidence?: number;
}

/** A cached flight price older than this is stale and triggers a refresh. */
export const PRICE_STALENESS_MS = 60 * 1000;

/** Minimum gap between refresh attempts for the same flight (bounded frequency). */
export const MIN_REFRESH_INTERVAL_MS = 15 * 1000;

/** Cached price age at which freshness confidence has decayed to half. */
const CONFIDENCE_HALF_LIFE_MS = 5 * 60 * 1000;

/** Max recent observations kept per flight for the stability component. */
const MAX_HISTORY = 9;

interface CachedFlightPrice {
  price: FlightPrice;
  /** Prices observed before the currently cached one (most recent last). */
  history: number[];
  lastRefreshAttemptAt: number;
}

export interface ConversionQuote {
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  amount: number;
  convertedAmount: number;
  rate: number;
  fee: number;
  timestamp: Date;
}

export class PriceOracleService {
  private static instance: PriceOracleService;
  private rateCache: Map<SupportedCurrency, CurrencyRate> = new Map();
  private cacheExpiryMs = 60000; // 1 minute cache
  /** flightId+currency -> cached price, refreshed when stale (issue #535). */
  private priceCache: Map<string, CachedFlightPrice> = new Map();
  private readonly API_URL = process.env.ORACLE_API_URL || 'https://api.coincap.io/v2/rates';
  private readonly FALLBACK_RATES: Record<SupportedCurrency, number> = {
    USD: 1.0,
    EUR: 0.92,
    GBP: 0.79,
    XLM: 24.5,
    USDC: 1.0,
    USDT: 1.0,
  };

  private constructor() {
    this.initializeCache();
  }

  public static getInstance(): PriceOracleService {
    if (!PriceOracleService.instance) {
      PriceOracleService.instance = new PriceOracleService();
    }
    return PriceOracleService.instance;
  }

  private initializeCache() {
    // Initialize with fallback rates
    Object.entries(this.FALLBACK_RATES).forEach(([currency, rate]) => {
      this.rateCache.set(currency as SupportedCurrency, {
        currency: currency as SupportedCurrency,
        rate,
        timestamp: new Date(),
      });
    });
  }

  /**
   * Fetches current exchange rates for all supported currencies
   */
  public async fetchExchangeRates(): Promise<Map<SupportedCurrency, CurrencyRate>> {
    try {
      const response = await axios.get(this.API_URL, { timeout: 5000 });
      const data = response.data.data;
      
      // Update cache with real rates
      if (Array.isArray(data)) {
        data.forEach((rateData: any) => {
          const currency = this.mapCurrencyId(rateData.id);
          if (currency) {
            this.rateCache.set(currency, {
              currency,
              rate: parseFloat(rateData.rateUsd),
              timestamp: new Date(),
            });
          }
        });
      }
      
      logger.info('Exchange rates updated successfully');
      return this.rateCache;
    } catch (error) {
      logger.warn('Failed to fetch exchange rates, using cached/fallback rates', error);
      return this.rateCache;
    }
  }

  private mapCurrencyId(id: string): SupportedCurrency | null {
    const mapping: Record<string, SupportedCurrency> = {
      'usd': 'USD',
      'eur': 'EUR',
      'gbp': 'GBP',
      'stellar': 'XLM',
      'usd-coin': 'USDC',
      'tether': 'USDT',
    };
    return mapping[id.toLowerCase()] || null;
  }

  /**
   * Get current rate for a specific currency
   */
  public getRate(currency: SupportedCurrency): number {
    const cached = this.rateCache.get(currency);
    if (!cached) {
      logger.warn(`No rate found for ${currency}, using fallback`);
      return this.FALLBACK_RATES[currency] || 1.0;
    }
    
    // Check if cache is expired
    const age = Date.now() - cached.timestamp.getTime();
    if (age > this.cacheExpiryMs) {
      // Async refresh cache
      this.fetchExchangeRates().catch(err => 
        logger.error('Failed to refresh exchange rates', err)
      );
    }
    
    return cached.rate;
  }

  /**
   * Convert amount from one currency to another
   */
  public convertCurrency(
    amount: number,
    fromCurrency: SupportedCurrency,
    toCurrency: SupportedCurrency
  ): ConversionQuote {
    const fromRate = this.getRate(fromCurrency);
    const toRate = this.getRate(toCurrency);
    
    // Convert to USD base first, then to target
    const usdAmount = amount / fromRate;
    const convertedAmount = usdAmount * toRate;
    
    // Calculate conversion fee (0.5%)
    const fee = convertedAmount * 0.005;
    const finalAmount = convertedAmount - fee;
    
    return {
      fromCurrency,
      toCurrency,
      amount,
      convertedAmount: finalAmount,
      rate: toRate / fromRate,
      fee,
      timestamp: new Date(),
    };
  }

  /**
   * Fetches current price for a list of flights in specified currency
   *
   * Serves fresh entries from the price cache and refreshes only stale
   * ones (issue #535). Refresh frequency is bounded per flight, so a burst
   * of concurrent callers cannot hammer the upstream oracle.
   */
  public async fetchPrices(
    flightIds: string[],
    targetCurrency: SupportedCurrency = 'USD'
  ): Promise<FlightPrice[]> {
    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const prices = await Promise.all(
          flightIds.map((id) => this.getOrRefreshPrice(id, targetCurrency)),
        );
        return prices;
      } catch (error) {
        retries++;
        const delay = Math.pow(2, retries) * 1000;
        logger.warn(`Failed to fetch prices. Retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`);
        if (retries === maxRetries) {
          logger.error('Max retries reached. Failed to fetch prices from Oracle.', error);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return [];
  }

  /**
   * True when the cached price for this flight+currency is missing or
   * older than PRICE_STALENESS_MS.
   */
  public isStale(flightId: string, currency: SupportedCurrency = 'USD'): boolean {
    const cached = this.priceCache.get(this.priceCacheKey(flightId, currency));
    if (!cached) return true;
    return this.priceAgeMs(cached) >= PRICE_STALENESS_MS;
  }

  /** Milliseconds since the cached price was observed, or null if none. */
  public getPriceAgeMs(flightId: string, currency: SupportedCurrency = 'USD'): number | null {
    const cached = this.priceCache.get(this.priceCacheKey(flightId, currency));
    if (!cached) return null;
    return this.priceAgeMs(cached);
  }

  /**
   * Publishes a confidence score in [0, 1] for a flight's current price
   * (issue #535). It combines:
   *  - freshness: decays toward 0 as the cached price ages (half-life
   *    CONFIDENCE_HALF_LIFE_MS); no data at all means 0.
   *  - stability: a small relative spread across recent observations
   *    pushes confidence toward 1; a wide spread pulls it toward 0.
   */
  public getConfidence(flightId: string, currency: SupportedCurrency = 'USD'): number {
    const cached = this.priceCache.get(this.priceCacheKey(flightId, currency));
    if (!cached) return 0;

    const freshness = Math.pow(0.5, this.priceAgeMs(cached) / CONFIDENCE_HALF_LIFE_MS);

    const observations = [...cached.history, cached.price.price];
    let stability = 1;
    if (observations.length >= 2) {
      const mean = observations.reduce((sum, p) => sum + p, 0) / observations.length;
      const spread = mean > 0 ? (Math.max(...observations) - Math.min(...observations)) / mean : 1;
      // 0% spread -> 1.0; 30% spread or more -> 0.0
      stability = Math.max(0, Math.min(1, 1 - spread / 0.3));
    }

    return Number((freshness * stability).toFixed(3));
  }

  /**
   * Explicit refresh trigger: re-fetches the given flights through the
   * bounded refresh path (at most one upstream attempt per
   * MIN_REFRESH_INTERVAL_MS per flight). Returns the prices now available.
   */
  public async refreshPrices(
    flightIds: string[],
    targetCurrency: SupportedCurrency = 'USD',
  ): Promise<FlightPrice[]> {
    return Promise.all(flightIds.map((id) => this.getOrRefreshPrice(id, targetCurrency, true)));
  }

  private priceCacheKey(flightId: string, currency: SupportedCurrency): string {
    return `${flightId}:${currency}`;
  }

  private priceAgeMs(cached: CachedFlightPrice): number {
    return Math.max(0, Date.now() - cached.price.timestamp.getTime());
  }

  /**
   * Cache-aside read for one flight. When the entry is stale a refresh is
   * attempted, but at most once per MIN_REFRESH_INTERVAL_MS per flight;
   * concurrent and back-to-back callers within that window share the
   * cached value. If the refresh fails and a previous price exists, the
   * last known price is served with its (decayed) confidence score rather
   * than throwing — error handling for the no-cache case is unchanged.
   */
  private async getOrRefreshPrice(
    flightId: string,
    targetCurrency: SupportedCurrency,
    force = false,
  ): Promise<FlightPrice> {
    const key = this.priceCacheKey(flightId, targetCurrency);
    let cached = this.priceCache.get(key);
    const stale = !cached || this.priceAgeMs(cached) >= PRICE_STALENESS_MS;

    if (stale || force) {
      const lastAttempt = cached?.lastRefreshAttemptAt ?? 0;
      if (Date.now() - lastAttempt >= MIN_REFRESH_INTERVAL_MS) {
        try {
          const fetched = await this.mockApiCall([flightId], targetCurrency);
          const fresh = fetched[0];
          this.priceCache.set(key, {
            price: fresh,
            history: cached ? [...cached.history, cached.price.price].slice(-MAX_HISTORY) : [],
            lastRefreshAttemptAt: Date.now(),
          });
        } catch (error) {
          // Bound failed attempts too so a flaky upstream is not hammered.
          if (cached) {
            cached.lastRefreshAttemptAt = Date.now();
            logger.warn('Price refresh failed; serving last known price', {
              flightId,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            throw error;
          }
        }
      }
    }

    cached = this.priceCache.get(key);
    if (!cached) {
      // No cache and the refresh window was closed: make one direct attempt
      // (preserves the original behaviour for a cold, rate-limited cache).
      const fetched = await this.mockApiCall([flightId], targetCurrency);
      const fresh = fetched[0];
      this.priceCache.set(key, {
        price: fresh,
        history: [],
        lastRefreshAttemptAt: Date.now(),
      });
      return { ...fresh, confidence: this.getConfidence(flightId, targetCurrency) };
    }

    return { ...cached.price, confidence: this.getConfidence(flightId, targetCurrency) };
  }

  // Simulate API call for demonstration
  private async mockApiCall(
    flightIds: string[],
    targetCurrency: SupportedCurrency = 'USD'
  ): Promise<FlightPrice[]> {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const basePrice = 100 + Math.random() * 50;
    const conversion = this.convertCurrency(basePrice, 'USD', targetCurrency);
    
    return flightIds.map(id => ({
      flightId: id,
      price: conversion.convertedAmount,
      currency: targetCurrency,
      timestamp: new Date(),
      source: 'PriceOracle'
    }));
  }

  /**
   * Get historical price data for a flight (mock implementation)
   */
  public async getHistoricalPrices(
    _flightId: string,
    days: number = 30
  ): Promise<{ date: Date; price: number }[]> {
    const prices: { date: Date; price: number }[] = [];
    const now = new Date();
    
    for (let i = days; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const basePrice = 100 + Math.random() * 50;
      prices.push({ date, price: basePrice });
    }
    
    return prices;
  }
}
