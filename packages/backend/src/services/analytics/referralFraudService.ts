/**
 * Referral fraud heuristics (issue #540).
 *
 * Pure, side-effect-free detection of referral abuse signals over data the
 * referral flow already collects (clicks with IPs, conversions) plus the
 * aggregated analytics available in the loyalty store. Heuristics FLAG,
 * they never block: the result carries a risk score and a recommended
 * action of `allow` or `flag`, and callers log flagged activity for review.
 */

export type ReferralFraudFlag =
  | 'self_referral'
  | 'ip_cluster'
  | 'one_time_use_anomaly'
  | 'velocity_anomaly';

export interface ReferralClickRecord {
  refereeId?: string;
  ip?: string | null;
  userAgent?: string | null;
  clickedAt: Date;
}

export interface ReferralConversionRecord {
  refereeId: string;
  convertedAt: Date;
  bookingValueCents?: number;
}

export interface ReferralFraudSignals {
  referrerId: string;
  /** The candidate referee currently being evaluated. */
  refereeId: string;
  /** IP the referee is connecting from (if known). */
  refereeIp?: string | null;
  /** Prior tracked clicks for this referral code. */
  clicks: ReferralClickRecord[];
  /** Prior successful conversions for this referral code. */
  conversions: ReferralConversionRecord[];
  /** Evaluation time; defaults to now (injectable for tests). */
  now?: Date;
}

export interface ReferralFraudAssessment {
  flags: ReferralFraudFlag[];
  /** 0 (clean) .. 100 (highly suspicious). */
  riskScore: number;
  severity: 'low' | 'medium' | 'high';
  /** Heuristics flag, they never block. */
  recommendedAction: 'allow' | 'flag';
  reasons: string[];
}

/** Distinct referees converting from one IP before it is flagged as a cluster. */
export const IP_CLUSTER_THRESHOLD = 3;

/** Clicks-per-conversion ratio below which the funnel looks manufactured. */
export const ONE_TIME_USE_CLICK_RATIO = 1;

/** Minimum conversions inside the velocity window before flagging. */
export const VELOCITY_WINDOW_CONVERSIONS = 5;

/** Velocity window size. */
export const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Risk points contributed by each flag. */
const FLAG_RISK_WEIGHTS: Record<ReferralFraudFlag, number> = {
  self_referral: 60,
  one_time_use_anomaly: 25,
  velocity_anomaly: 30,
  ip_cluster: 25,
};

/**
 * Evaluates a referral against the fraud heuristics. Pure function so it
 * can be unit-tested against synthetic signal data without a database or
 * HTTP layer.
 */
export function assessReferralFraud(signals: ReferralFraudSignals): ReferralFraudAssessment {
  const flags = new Set<ReferralFraudFlag>();
  const reasons: string[] = [];

  // --- Self-referral -----------------------------------------------------
  // The referee is the referrer, or the referee has previously appeared as
  // a clicker/converter on this referrer's own code.
  if (signals.refereeId === signals.referrerId) {
    flags.add('self_referral');
    reasons.push('Referee identifier matches the referrer');
  } else {
    const priorSelf = [...signals.clicks, ...signals.conversions].some(
      (record) => 'refereeId' in record && record.refereeId === signals.referrerId,
    );
    if (priorSelf) {
      flags.add('self_referral');
      reasons.push('Referrer previously interacted with their own code as a referee');
    }
  }

  // --- IP cluster ----------------------------------------------------------
  // One IP driving many distinct conversions (click farms, device farms).
  const ipOwners = new Map<string, Set<string>>();
  for (const conversion of signals.conversions) {
    for (const click of signals.clicks) {
      if (click.refereeId === conversion.refereeId && click.ip) {
        const owners = ipOwners.get(click.ip) ?? new Set<string>();
        owners.add(conversion.refereeId);
        ipOwners.set(click.ip, owners);
      }
    }
  }
  if (signals.refereeIp) {
    const owners = ipOwners.get(signals.refereeIp) ?? new Set<string>();
    owners.add(signals.refereeId);
    ipOwners.set(signals.refereeIp, owners);
  }
  for (const [ip, owners] of ipOwners) {
    if (owners.size >= IP_CLUSTER_THRESHOLD) {
      flags.add('ip_cluster');
      reasons.push(
        `IP ${maskIp(ip)} is associated with ${owners.size} distinct referees (threshold ${IP_CLUSTER_THRESHOLD})`,
      );
      break;
    }
  }

  // --- One-time-use anomaly -------------------------------------------------
  // Many conversions with barely any click trail: the funnel looks manufactured.
  const conversionCount = signals.conversions.length;
  const clickCount = signals.clicks.length;
  if (
    conversionCount >= IP_CLUSTER_THRESHOLD &&
    clickCount < conversionCount * ONE_TIME_USE_CLICK_RATIO
  ) {
    flags.add('one_time_use_anomaly');
    reasons.push(
      `${conversionCount} conversions against only ${clickCount} tracked clicks`,
    );
  }

  // --- Velocity -------------------------------------------------------------
  // Burst of conversions inside a short window.
  const now = signals.now ?? new Date();
  const recent = signals.conversions.filter(
    (conversion) =>
      now.getTime() - conversion.convertedAt.getTime() <= VELOCITY_WINDOW_MS,
  );
  if (recent.length >= VELOCITY_WINDOW_CONVERSIONS) {
    flags.add('velocity_anomaly');
    reasons.push(
      `${recent.length} conversions within 24h (threshold ${VELOCITY_WINDOW_CONVERSIONS})`,
    );
  }

  const riskScore = Math.min(
    100,
    Array.from(flags).reduce((score, flag) => score + FLAG_RISK_WEIGHTS[flag], 0),
  );

  return {
    flags: Array.from(flags),
    riskScore,
    severity: riskScore >= 60 ? 'high' : riskScore >= 25 ? 'medium' : 'low',
    recommendedAction: flags.size > 0 ? 'flag' : 'allow',
    reasons,
  };
}

/** Never log full client IPs; keep the last octet masked. */
function maskIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return 'masked';
}
