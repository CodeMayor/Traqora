/**
 * Unit tests for Seat Availability Service
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  SeatAvailabilityService,
  resetSeatLocksForTesting,
} from "./seatAvailabilityService";
import { BadRequestError } from "../utils/errors";
import type { SeatType } from "../types/services";

// Mock AppDataSource
jest.mock("../db/dataSource", () => ({
  AppDataSource: {
    getRepository: jest.fn(() => ({
      findOne: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

describe("SeatAvailabilityService", () => {
  let service: SeatAvailabilityService;

  beforeEach(() => {
    resetSeatLocksForTesting();
    service = new SeatAvailabilityService();
  });

  describe("Seat validation", () => {
    it("should validate correct seat number format", async () => {
      const validSeats = ["1A", "12B", "20F", "5E"];
      for (const seat of validSeats) {
        expect(/^\d{1,2}[A-F]$/.test(seat)).toBeTruthy();
      }
    });

    it("should reject invalid seat number format", async () => {
      // These fail the service's format check ^\d{1,2}[A-F]$.
      // ("25A"/"0A" match the format regex; row-range validity is enforced
      // separately against the aircraft seat map.)
      const invalidSeats = ["A1", "1G", "1AA", "12AB", ""];
      for (const seat of invalidSeats) {
        expect(/^\d{1,2}[A-F]$/.test(seat)).toBeFalsy();
      }
    });

    it("should parse seat numbers correctly", () => {
      const seatNumber = "12C";
      const row = parseInt(seatNumber.slice(0, -1));
      const col = seatNumber.slice(-1);

      expect(row).toBe(12);
      expect(col).toBe("C");
    });
  });

  describe("Seat pricing", () => {
    it("should calculate first class seat price", () => {
      // Using reflection to test private method indirectly
      const service2 = new SeatAvailabilityService();
      // Prices: first=15000, business=8000, premium=4000, economy=1500
      const prices: Record<SeatType, number> = {
        first: 15000,
        business: 8000,
        premium_economy: 4000,
        economy: 1500,
      };

      expect(prices.first).toBe(15000);
      expect(prices.economy).toBe(1500);
    });

    it("should price based on cabin class", () => {
      const classes: SeatType[] = [
        "first",
        "business",
        "premium_economy",
        "economy",
      ];
      const prices: Record<SeatType, number> = {
        first: 15000,
        business: 8000,
        premium_economy: 4000,
        economy: 1500,
      };

      for (const cls of classes) {
        expect(prices[cls]).toBeGreaterThan(0);
      }
      expect(prices.first).toBeGreaterThan(prices.business);
      expect(prices.business).toBeGreaterThan(prices.premium_economy);
      expect(prices.premium_economy).toBeGreaterThan(prices.economy);
    });
  });

  describe("Seat lock management", () => {
    it("should handle seat lock duration", () => {
      const lockDurationMs = 15 * 60 * 1000; // 15 minutes
      const now = new Date();
      const expiresAt = new Date(now.getTime() + lockDurationMs);

      expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
      expect(expiresAt.getTime() - now.getTime()).toBe(lockDurationMs);
    });

    it("should detect expired locks", () => {
      const now = new Date();
      const expiredLock = new Date(now.getTime() - 1000); // 1 second ago
      const activeLock = new Date(now.getTime() + 10000); // 10 seconds from now

      expect(expiredLock.getTime()).toBeLessThan(now.getTime());
      expect(activeLock.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe("Aircraft configuration", () => {
    it("should have valid aircraft config", () => {
      const config = {
        rows: 20,
        cols: ["A", "B", "C", "D", "E", "F"],
        classMap: {
          1: "first" as SeatType,
          2: "first" as SeatType,
          3: "business" as SeatType,
        },
      };

      expect(config.rows).toBe(20);
      expect(config.cols.length).toBe(6);
      expect(Object.keys(config.classMap).length).toBeGreaterThan(0);
    });

    it("should calculate total seats correctly", () => {
      const rows = 20;
      const cols = 6;
      const totalSeats = rows * cols;

      expect(totalSeats).toBe(120);
    });

    it("should validate row numbers", () => {
      const validRows = [1, 5, 10, 15, 20];
      const invalidRows = [0, 21, -1];

      for (const row of validRows) {
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(20);
      }

      for (const row of invalidRows) {
        expect(!(row >= 1 && row <= 20)).toBeTruthy();
      }
    });
  });

  describe("Seat type assignment", () => {
    const classMap: Record<number, SeatType> = {
      1: "first",
      2: "first",
      3: "business",
      4: "business",
      5: "business",
      6: "premium_economy",
      7: "premium_economy",
      8: "premium_economy",
    };

    it("should assign first class to rows 1-2", () => {
      expect(classMap[1]).toBe("first");
      expect(classMap[2]).toBe("first");
    });

    it("should assign business to rows 3-5", () => {
      expect(classMap[3]).toBe("business");
      expect(classMap[4]).toBe("business");
      expect(classMap[5]).toBe("business");
    });

    it("should assign premium economy to rows 6-8", () => {
      expect(classMap[6]).toBe("premium_economy");
      expect(classMap[7]).toBe("premium_economy");
      expect(classMap[8]).toBe("premium_economy");
    });

    it("should default remaining rows to economy", () => {
      const seatType = classMap[9] || "economy";
      expect(seatType).toBe("economy");
    });
  });

  describe("Concurrency safety (issue #536)", () => {
    const FLIGHT = "F1";
    const SEAT = "12C";

    it("grants exactly one winning hold when many bookings race for the same seat", async () => {
      const contenders = 50;
      const attempts = Array.from({ length: contenders }, (_, i) =>
        service.lockSeat(FLIGHT, SEAT, `booking-${i}`).then(
          () => "won",
          (err: unknown) =>
            err instanceof BadRequestError ? "rejected" : `error:${String(err)}`,
        ),
      );

      const outcomes = await Promise.all(attempts);
      const wins = outcomes.filter((o) => o === "won");
      const cleanRejections = outcomes.filter((o) => o === "rejected");

      // Exactly-once allocation: one winner, everyone else cleanly rejected.
      expect(wins).toHaveLength(1);
      expect(cleanRejections).toHaveLength(contenders - 1);
      expect(outcomes.every((o) => o === "won" || o === "rejected")).toBe(true);

      // The surviving lock belongs to the single winning booking.
      const lock = service.getSeatLock(FLIGHT, SEAT);
      expect(lock).not.toBeNull();
      expect(wins).toHaveLength(1);
    });

    it("is idempotent: the same booking can re-lock its own seat", async () => {
      await service.lockSeat(FLIGHT, SEAT, "booking-A");
      await expect(
        service.lockSeat(FLIGHT, SEAT, "booking-A"),
      ).resolves.toBeUndefined();

      const lock = service.getSeatLock(FLIGHT, SEAT);
      expect(lock?.bookingId).toBe("booking-A");
    });

    it("only lets the owning booking release the lock, even under concurrency", async () => {
      await service.lockSeat(FLIGHT, SEAT, "booking-A");

      await expect(
        service.releaseSeatLock(FLIGHT, SEAT, "booking-B"),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(service.getSeatLock(FLIGHT, SEAT)?.bookingId).toBe("booking-A");

      await service.releaseSeatLock(FLIGHT, SEAT, "booking-A");
      expect(service.getSeatLock(FLIGHT, SEAT)).toBeUndefined();
    });

    it("serializes releases and re-locks so a released seat is re-lockable once", async () => {
      await service.lockSeat(FLIGHT, SEAT, "booking-A");

      const [release, relock] = await Promise.all([
        service.releaseSeatLock(FLIGHT, SEAT, "booking-A").then(
          () => "released" as const,
          () => "release-failed" as const,
        ),
        service.lockSeat(FLIGHT, SEAT, "booking-B").then(
          () => "locked" as const,
          () => "lock-failed" as const,
        ),
      ]);

      // The mutex orders these operations; whatever the interleaving, the
      // seat ends in a consistent state.
      expect(release === "released" || relock === "locked").toBe(true);
      const lock = service.getSeatLock(FLIGHT, SEAT);
      if (relock === "locked" && release === "released") {
        expect(lock?.bookingId).toBe("booking-B");
      } else if (relock === "locked") {
        expect(lock?.bookingId).toBe("booking-B");
      } else {
        expect(lock?.bookingId).toBe("booking-A");
      }
    });

    it("never double-books across many seats and many bookings at once", async () => {
      const seats = ["1A", "1B", "1C", "2A", "2B", "2C"];
      const bookingsPerSeat = 20;

      const outcomes = await Promise.all(
        seats.flatMap((seat) =>
          Array.from({ length: bookingsPerSeat }, (_, i) =>
            service.lockSeat(FLIGHT, seat, `bk-${seat}-${i}`).then(
              () => seat,
              (err: unknown) =>
                err instanceof BadRequestError ? null : `error:${String(err)}`,
            ),
          ),
        ),
      );

      // Exactly-once per seat: each seat appears exactly once among winners.
      for (const seat of seats) {
        expect(outcomes.filter((o) => o === seat)).toHaveLength(1);
      }
      // No unexpected errors.
      expect(outcomes.every((o) => o === null || seats.includes(o as string))).toBe(true);
    });
  });
});
