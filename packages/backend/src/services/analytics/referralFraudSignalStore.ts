import { AppDataSource } from "../../db/dataSource";
import { ReferralFraudSignal } from "../../db/entities/ReferralFraudSignal";
import {
  ReferralClickRecord,
  ReferralConversionRecord,
} from "./referralFraudService";

const REFERRAL_LOG_CAP = 500;
const fallbackSignals = new Map<string, ReferralFraudSignal[]>();

export function resetReferralFraudSignalsForTesting(): void {
  fallbackSignals.clear();
}

export interface ReferralFraudHistory {
  clicks: ReferralClickRecord[];
  conversions: ReferralConversionRecord[];
}

export async function recordReferralClick(
  referralCode: string,
  record: ReferralClickRecord,
): Promise<void> {
  await recordSignal(referralCode, {
    type: "click",
    refereeId: record.refereeId ?? null,
    ip: record.ip ?? null,
    userAgent: record.userAgent ?? null,
    createdAt: record.clickedAt,
  });
}

export async function recordReferralConversion(
  referralCode: string,
  record: ReferralConversionRecord,
): Promise<void> {
  await recordSignal(referralCode, {
    type: "conversion",
    refereeId: record.refereeId,
    ip: record.ip ?? null,
    userAgent: null,
    createdAt: record.convertedAt,
  });
}

export async function getReferralFraudHistory(
  referralCode: string,
): Promise<ReferralFraudHistory> {
  const records = await getSignals(referralCode);
  return {
    clicks: records
      .filter((record) => record.type === "click")
      .map((record) => ({
        refereeId: record.refereeId ?? undefined,
        ip: record.ip,
        userAgent: record.userAgent,
        clickedAt: record.createdAt,
      })),
    conversions: records
      .filter((record) => record.type === "conversion")
      .map((record) => ({
        refereeId: record.refereeId ?? "",
        ip: record.ip,
        convertedAt: record.createdAt,
      })),
  };
}

async function recordSignal(
  referralCode: string,
  signal: Pick<
    ReferralFraudSignal,
    "type" | "refereeId" | "ip" | "userAgent" | "createdAt"
  >,
): Promise<void> {
  if (AppDataSource.isInitialized) {
    const repository = AppDataSource.getRepository(ReferralFraudSignal);
    await repository.save({ referralCode, ...signal });

    const oldSignals = await repository.find({
      where: { referralCode },
      order: { createdAt: "DESC" },
      skip: REFERRAL_LOG_CAP,
      select: { id: true },
    });
    if (oldSignals.length > 0) {
      await repository.delete(oldSignals.map(({ id }) => id));
    }
    return;
  }

  const signals = fallbackSignals.get(referralCode) ?? [];
  signals.push({ id: "", referralCode, ...signal });
  if (signals.length > REFERRAL_LOG_CAP) signals.shift();
  fallbackSignals.set(referralCode, signals);
}

async function getSignals(referralCode: string): Promise<ReferralFraudSignal[]> {
  if (AppDataSource.isInitialized) {
    return AppDataSource.getRepository(ReferralFraudSignal).find({
      where: { referralCode },
      order: { createdAt: "DESC" },
      take: REFERRAL_LOG_CAP,
    });
  }
  return [...(fallbackSignals.get(referralCode) ?? [])].reverse();
}
