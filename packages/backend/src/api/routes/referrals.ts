/**
 * Referral program routes (issue #311, hardened in #377).
 *
 * Scope:
 *   POST /referrals/codes           — generate a unique referral code for the user
 *   POST /referrals/invite          — email a referral invitation on the user's behalf
 *   GET  /referrals/dashboard       — stats: clicks, conversions, earned points
 *   POST /referrals/track           — record a referral click
 *   POST /referrals/convert         — convert a referral when referee completes first booking
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler } from '../../utils/errorHandler';
import { requireAuth } from '../../middleware/authMiddleware';
import { LoyaltyStore } from '../../services/loyalty/store';
import { LoyaltyAccount, ReferralStats } from '../../types/loyalty';
import { logger } from '../../utils/logger';
import { emailService } from '../../services/EmailService';
import { BadRequestError } from '../../utils/errors';
import {
  assessReferralFraud,
  maskReferralIp,
  ReferralClickRecord,
  ReferralConversionRecord,
} from '../../services/analytics/referralFraudService';
import {
  getReferralFraudHistory,
  recordReferralClick,
  recordReferralConversion,
} from '../../services/analytics/referralFraudSignalStore';

const router = Router();

const BASE_REFERRAL_POINTS  = 500;
const REFEREE_WELCOME_POINTS = 100;
const TIER_MULTIPLIERS: Record<string, number> = {
  bronze:   1,
  silver:   1.5,
  gold:     2,
  platinum: 3,
  diamond:  4,
};

const convertReferralSchema = z.object({
  referralCode: z.string().min(6).max(32),
  refereeId:    z.string().min(1),
  bookingId:    z.string().min(1),
  bookingValue: z.number().positive(),
});

const trackClickSchema = z.object({
  referralCode: z.string().min(6).max(32),
  refereeId:    z.string().min(1).optional(),
  refereeIp:    z.string().optional(),
  userAgent:    z.string().optional(),
});

const inviteSchema = z.object({
  email:       z.string().trim().email(),
  inviterName: z.string().trim().min(1).max(80).optional(),
});

const INVITE_BASE_URL = process.env.APP_BASE_URL || 'https://traqora.com';
const conversionQueues = new Map<string, Promise<void>>();

async function withReferralConversionLock<T>(
  referralCode: string,
  refereeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${referralCode}\u0000${refereeId}`;
  const previous = conversionQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  conversionQueues.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (conversionQueues.get(key) === queued) {
      conversionQueues.delete(key);
    }
  }
}

function emptyStats(): ReferralStats {
  return { totalClicks: 0, totalConversions: 0, pendingPoints: 0, earnedPoints: 0, referees: [] };
}

/**
 * Returns the user's existing referral code, generating and persisting one
 * on first use. Shared by /codes and /invite so both always resolve the
 * same code for a given account. Persists via updateAccount — the store's
 * getOrCreateAccount returns a defensive copy, so mutating it in place
 * (as the original implementation did) silently discarded every change.
 */
function getOrCreateReferralCode(store: LoyaltyStore, userId: string): { code: string; existing: boolean } {
  const account = store.getOrCreateAccount(userId);
  if (account.referralCode) {
    return { code: account.referralCode, existing: true };
  }

  const code = `REF-${userId.slice(0, 6).toUpperCase()}-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  account.referralCode = code;
  store.updateAccount(account);
  return { code, existing: false };
}

function findAccountByReferralCode(store: LoyaltyStore, referralCode: string): LoyaltyAccount | undefined {
  const codePrefix = referralCode.replace('REF-', '').split('-')[0];
  return store
    .getAllAccounts()
    .find((a) => a.referralCode === referralCode || a.userId.toUpperCase().startsWith(codePrefix));
}

/**
 * POST /referrals/codes
 * Authenticated — generates or retrieves a unique referral code for the current user.
 */
router.post(
  '/codes',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.walletAddress;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const store = LoyaltyStore.getInstance();
    const { code, existing } = getOrCreateReferralCode(store, userId);

    if (existing) {
      res.json({ referralCode: code, userId, existing: true });
      return;
    }

    logger.info('referral: code generated', { userId, code });

    res.status(201).json({ referralCode: code, userId, existing: false });
  }),
);

/**
 * POST /referrals/invite
 * Authenticated — emails a referral invitation on the current user's behalf,
 * generating their referral code first if they don't have one yet.
 */
router.post(
  '/invite',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.walletAddress;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Validation error', parsed.error.flatten());
    }

    const { email, inviterName } = parsed.data;
    const store = LoyaltyStore.getInstance();
    const { code } = getOrCreateReferralCode(store, userId);

    const displayName = inviterName ?? `${userId.slice(0, 4)}...${userId.slice(-4)}`;
    const inviteUrl = `${INVITE_BASE_URL}/signup?ref=${encodeURIComponent(code)}`;

    await emailService.send(email, 'referral-invite', {
      inviterName: displayName,
      referralCode: code,
      inviteUrl,
    });

    logger.info('referral: invite sent', { userId, email, referralCode: code });

    res.status(202).json({ invited: true, email, referralCode: code });
  }),
);

/**
 * GET /referrals/dashboard
 * Authenticated — returns referral stats for the current user.
 */
router.get(
  '/dashboard',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.walletAddress;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const store   = LoyaltyStore.getInstance();
    const account = store.getOrCreateAccount(userId);

    res.json({
      userId,
      referralCode: account.referralCode ?? null,
      stats: account.referralStats ?? emptyStats(),
      tier:  account.tier,
    });
  }),
);

/**
 * POST /referrals/track
 * Public — records a referral link click for attribution against the
 * referrer's dashboard stats. Suspicious activity is flagged, not blocked.
 */
router.post(
  '/track',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = trackClickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { referralCode, refereeId, refereeIp, userAgent } = parsed.data;
    const requesterIp = req.ip;

    const store   = LoyaltyStore.getInstance();
    const referrer = findAccountByReferralCode(store, referralCode);
    if (!referrer) {
      res.status(404).json({ error: 'Referral code not found or expired' });
      return;
    }

    // Fraud heuristics (issue #540): flag, never block.
    const clickIp = requesterIp ?? refereeIp ?? null;
    const clickRecord: ReferralClickRecord = {
      refereeId,
      ip: clickIp,
      userAgent: userAgent ?? null,
      clickedAt: new Date(),
    };
    await recordReferralClick(referralCode, clickRecord);
    const history = await getReferralFraudHistory(referralCode);
    const fraud = assessReferralFraud({
      referrerId: referrer.userId,
      refereeId: refereeId ?? 'anonymous-click',
      refereeIp: clickIp,
      clicks: history.clicks,
      conversions: history.conversions,
    });
    if (fraud.recommendedAction === 'flag') {
      logger.warn('referral: suspicious click flagged by heuristics', {
        referralCode,
        ip: clickIp ? maskReferralIp(clickIp) : null,
        flags: fraud.flags,
        riskScore: fraud.riskScore,
        reasons: fraud.reasons,
      });
    }

    const stats = referrer.referralStats ?? emptyStats();
    stats.totalClicks += 1;
    referrer.referralStats = stats;
    store.updateAccount(referrer);

    logger.info('referral: click tracked', {
      referralCode,
      refereeIp: clickIp ? maskReferralIp(clickIp) : null,
      userAgent,
    });
    res.status(201).json({
      tracked: true,
      referralCode,
      ...(fraud.flags.length > 0 ? { fraud } : {}),
    });
  }),
);

/**
 * POST /referrals/convert
 * Internal/webhook — converts a referral when the referee completes their first booking.
 * Awards BASE_REFERRAL_POINTS × tier multiplier to referrer; REFEREE_WELCOME_POINTS to referee.
 * Fraud guard: a referee can only convert once; suspicious activity is flagged.
 */
router.post(
  '/convert',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = convertReferralSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { referralCode, refereeId, bookingId } = parsed.data;

    await withReferralConversionLock(referralCode, refereeId, async () => {
      const store    = LoyaltyStore.getInstance();
      const referrer = findAccountByReferralCode(store, referralCode);

      if (!referrer) {
        res.status(404).json({ error: 'Referral code not found or expired' });
        return;
      }

      const conversions = referrer.referralConversions ?? [];
      if (conversions.includes(refereeId)) {
        res.status(409).json({ error: 'Referee has already converted for this referral' });
        return;
      }

      // Include the candidate conversion so thresholds apply on the exact event.
      const history = await getReferralFraudHistory(referralCode);
      const candidateConversion: ReferralConversionRecord = {
        refereeId,
        ip: req.ip ?? null,
        convertedAt: new Date(),
      };
      const fraud = assessReferralFraud({
        referrerId: referrer.userId,
        refereeId,
        refereeIp: req.ip ?? null,
        clicks: history.clicks,
        conversions: [...history.conversions, candidateConversion],
      });
      if (fraud.recommendedAction === 'flag') {
        logger.warn('referral: conversion flagged by fraud heuristics', {
          referralCode,
          refereeId,
          flags: fraud.flags,
          riskScore: fraud.riskScore,
          reasons: fraud.reasons,
        });
      }

      const tier         = referrer.tier ?? 'bronze';
      const multiplier   = TIER_MULTIPLIERS[tier] ?? 1;
      const pointsEarned = Math.round(BASE_REFERRAL_POINTS * multiplier);

      await recordReferralConversion(referralCode, candidateConversion);
      conversions.push(refereeId);
      referrer.referralConversions = conversions;

      const stats = referrer.referralStats ?? emptyStats();
      stats.totalConversions += 1;
      stats.earnedPoints += pointsEarned;
      stats.referees = [...new Set([...stats.referees, refereeId])];
      referrer.referralStats = stats;

      store.updateAccount(referrer);
      store.getOrCreateAccount(refereeId);

      logger.info('referral: conversion processed', { referralCode, refereeId, bookingId, pointsEarned });

      res.status(201).json({
        referralCode,
        referrerId:            referrer.userId,
        refereeId,
        bookingId,
        referrerPointsAwarded: pointsEarned,
        refereePointsAwarded:  REFEREE_WELCOME_POINTS,
        tier,
        multiplier,
        processedAt: new Date().toISOString(),
        ...(fraud.flags.length > 0 ? { fraud } : {}),
      });
    });
  }),
);

export const referralRoutes = router;
