/**
 * Tests for referral fraud heuristics (issue #540), run on synthetic
 * signal data — no database or HTTP layer involved.
 */

import { beforeEach, describe, it, expect, jest } from '@jest/globals';
jest.mock('../src/db/dataSource', () => ({
  AppDataSource: { isInitialized: false },
  initDataSource: async () => undefined,
}));
jest.mock('../src/api/openapi/generator', () => ({ openApiDocument: {} }));
import request from 'supertest';
import { createApp } from '../src/app';
import { LoyaltyStore } from '../src/services/loyalty/store';
import { resetReferralFraudSignalsForTesting } from '../src/services/analytics/referralFraudSignalStore';
import {
  assessReferralFraud,
  IP_CLUSTER_THRESHOLD,
  VELOCITY_WINDOW_CONVERSIONS,
  ReferralClickRecord,
  ReferralConversionRecord,
} from '../src/services/analytics/referralFraudService';

const NOW = new Date('2026-08-31T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function clicks(
  n: number,
  ip: string | null = '203.0.113.10',
  refereePrefix = 'referee',
): ReferralClickRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    refereeId: `${refereePrefix}-${i}`,
    ip,
    clickedAt: hoursAgo(i + 1),
  }));
}

function conversions(n: number, prefix = 'referee'): ReferralConversionRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    refereeId: `${prefix}-${i}`,
    convertedAt: hoursAgo(i + 1),
  }));
}

const base = {
  referrerId: 'referrer-1',
  refereeId: 'new-user',
  refereeIp: '198.51.100.1' as string | null,
  clicks: clicks(5),
  conversions: conversions(1),
  now: NOW,
};

describe('referral fraud heuristics (#540)', () => {
  it('passes clean referral activity with no flags', () => {
    const result = assessReferralFraud(base);
    expect(result.flags).toEqual([]);
    expect(result.riskScore).toBe(0);
    expect(result.severity).toBe('low');
    expect(result.recommendedAction).toBe('allow');
  });

  it('flags a direct self-referral', () => {
    const result = assessReferralFraud({ ...base, refereeId: 'referrer-1' });
    expect(result.flags).toContain('self_referral');
    expect(result.recommendedAction).toBe('flag');
    expect(result.riskScore).toBeGreaterThanOrEqual(60);
    expect(result.severity).toBe('high');
  });

  it('flags when the referrer previously clicked their own code', () => {
    const result = assessReferralFraud({
      ...base,
      clicks: [...base.clicks, { refereeId: 'referrer-1', ip: null, clickedAt: hoursAgo(9) }],
    });
    expect(result.flags).toContain('self_referral');
  });

  it('flags an IP cluster once enough distinct referees share one IP', () => {
    const sharedIp = '203.0.113.66';
    const result = assessReferralFraud({
      ...base,
      refereeIp: sharedIp,
      clicks: clicks(IP_CLUSTER_THRESHOLD - 1, sharedIp, 'farmer'),
      conversions: conversions(IP_CLUSTER_THRESHOLD - 1, 'farmer'),
    });
    expect(result.flags).toContain('ip_cluster');
    expect(result.reasons.some((r) => r.includes('.x'))).toBe(true);
  });

  it('flags an IP cluster from persisted conversion IPs without click-to-referee linkage', () => {
    const sharedIp = '203.0.113.77';
    const result = assessReferralFraud({
      ...base,
      clicks: [],
      conversions: conversions(IP_CLUSTER_THRESHOLD, 'clustered').map((conversion) => ({
        ...conversion,
        ip: sharedIp,
      })),
    });
    expect(result.flags).toContain('ip_cluster');
  });

  it('does not flag a small number of referees on a shared IP', () => {
    const sharedIp = '203.0.113.66';
    const result = assessReferralFraud({
      ...base,
      refereeIp: '198.51.100.99',
      clicks: clicks(2, sharedIp, 'normal'),
      conversions: conversions(2, 'normal'),
    });
    expect(result.flags).not.toContain('ip_cluster');
  });

  it('flags a one-time-use anomaly: many conversions, no click trail', () => {
    const result = assessReferralFraud({
      ...base,
      clicks: [],
      conversions: conversions(5),
    });
    expect(result.flags).toContain('one_time_use_anomaly');
    expect(result.recommendedAction).toBe('flag');
  });

  it('flags conversion velocity bursts inside the window', () => {
    const burst = Array.from({ length: VELOCITY_WINDOW_CONVERSIONS }, (_, i) => ({
      refereeId: `burst-${i}`,
      convertedAt: hoursAgo(1),
    }));
    const result = assessReferralFraud({ ...base, conversions: burst, clicks: clicks(10) });
    expect(result.flags).toContain('velocity_anomaly');
  });

  it('ignores conversions outside the velocity window', () => {
    const old = Array.from({ length: VELOCITY_WINDOW_CONVERSIONS + 2 }, (_, i) => ({
      refereeId: `old-${i}`,
      convertedAt: hoursAgo(30),
    }));
    const result = assessReferralFraud({ ...base, conversions: old, clicks: clicks(20) });
    expect(result.flags).not.toContain('velocity_anomaly');
  });

  it('aggregates multiple flags into a high severity assessment', () => {
    const sharedIp = '203.0.113.66';
    const result = assessReferralFraud({
      ...base,
      refereeId: 'referrer-1',
      refereeIp: sharedIp,
      clicks: clicks(IP_CLUSTER_THRESHOLD - 1, sharedIp, 'farmer'),
      conversions: conversions(IP_CLUSTER_THRESHOLD - 1, 'farmer'),
    });
    expect(result.flags.length).toBeGreaterThanOrEqual(2);
    expect(result.severity).toBe('high');
    expect(result.riskScore).toBeGreaterThan(0);
  });

  it('never blocks: recommendedAction is allow or flag, never block', () => {
    const worst = assessReferralFraud({ ...base, refereeId: 'referrer-1' });
    expect(['allow', 'flag']).toContain(worst.recommendedAction);
  });
});

describe('referral fraud routes (#540)', () => {
  beforeEach(async () => {
    LoyaltyStore.resetForTesting();
    resetReferralFraudSignalsForTesting();
  });

  function appWithReferral(referrerId: string, referralCode: string) {
    const store = LoyaltyStore.getInstance();
    const account = store.getOrCreateAccount(referrerId);
    account.referralCode = referralCode;
    store.updateAccount(account);
    return createApp({ globalRateLimit: false, tieredRateLimit: false });
  }

  it('mounts referral tracking and flags self-referral without rejecting the click', async () => {
    const app = appWithReferral('self-referrer', 'REF-SELF-001');
    const response = await request(app)
      .post('/api/v1/referrals/track')
      .send({
        referralCode: 'REF-SELF-001',
        refereeId: 'self-referrer',
        refereeIp: '::ffff:127.0.0.1',
      });

    expect(response.status).toBe(201);
    expect(response.body.fraud.flags).toContain('self_referral');
  });

  it('flags but processes a self-referral conversion', async () => {
    const app = appWithReferral('self-referrer', 'REF-SELF-002');
    const response = await request(app)
      .post('/api/v1/referrals/convert')
      .send({
        referralCode: 'REF-SELF-002',
        refereeId: 'self-referrer',
        bookingId: 'booking-self',
        bookingValue: 100,
      });

    expect(response.status).toBe(201);
    expect(response.body.fraud.flags).toContain('self_referral');
  });

  it('processes simultaneous duplicate conversions exactly once', async () => {
    const app = appWithReferral('referrer-once', 'REF-ONCE-003');
    const body = {
      referralCode: 'REF-ONCE-003',
      refereeId: 'referee-once',
      bookingId: 'booking-once',
      bookingValue: 100,
    };
    const responses = await Promise.all([
      request(app).post('/api/v1/referrals/convert').send(body),
      request(app).post('/api/v1/referrals/convert').send(body),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(LoyaltyStore.getInstance().getOrCreateAccount('referrer-once').referralStats?.totalConversions).toBe(1);
  });
});
