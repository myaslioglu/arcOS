import { describe, expect, it } from "vitest";
import { USDC } from "@arcos/chain";
import {
  DAY,
  MAX_DURATION,
  PRESET_DAYS,
  UINT64_MAX,
  UNLOCK_ERRORS,
  USDC_GAS_RESERVE,
  checkAmount,
  checkExtend,
  checkUnlock,
  dateBounds,
  dateValue,
  extendBase,
  formatWhen,
  lockReserve,
  lpSplit,
  presetUnlock,
  unlockFromDate,
  untilText,
} from "../lockForm";

const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z

/** A small seeded generator (mulberry32), so the property checks below are the same on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const big = (max: bigint) => {
    let v = 0n;
    for (let i = 0; i < 7; i++) v = (v << 32n) | BigInt(int(0, 2 ** 32 - 1));
    return v % (max + 1n);
  };
  return { int, big };
}
const RUNS = 2_000;

describe("the unlock window, as LockVault and PositionVault check it (`_requireInWindow`)", () => {
  it("is 3650 days, the contracts' MAX_DURATION", () => {
    expect(MAX_DURATION).toBe(3650 * 86_400);
    expect(DAY).toBe(86_400);
  });

  it("refuses now and the past: the time must be after block.timestamp", () => {
    expect(checkUnlock(NOW, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.past });
    expect(checkUnlock(NOW - 1, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.past });
    expect(checkUnlock(0, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.past });
  });

  it("takes one second after now: there is no minimum length beyond that", () => {
    expect(checkUnlock(NOW + 1, NOW)).toEqual({ ok: true, unlockAt: NOW + 1 });
  });

  it("takes exactly MAX_DURATION from now, and refuses one second more", () => {
    expect(checkUnlock(NOW + MAX_DURATION, NOW)).toEqual({ ok: true, unlockAt: NOW + MAX_DURATION });
    expect(checkUnlock(NOW + MAX_DURATION + 1, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.tooFar });
  });

  it("refuses no time, a fraction, a negative and anything past uint64 as no date at all", () => {
    for (const bad of [null, NaN, Infinity, 1.5, -1, Number(UINT64_MAX) * 2]) {
      expect(checkUnlock(bad as number | null, NOW), String(bad)).toEqual({ ok: false, error: UNLOCK_ERRORS.missing });
    }
  });

  it("agrees with the contract's rule for any time and any now (property)", () => {
    const r = random(1);
    for (let i = 0; i < RUNS; i++) {
      const now = r.int(1_700_000_000, 2_000_000_000);
      // Half the draws land near the window's two edges, where an off-by-one would show.
      const at = i % 2 ? r.int(0, 4_000_000_000) : r.int(0, 1) ? now + r.int(-3, 3) : now + MAX_DURATION + r.int(-3, 3);
      expect(checkUnlock(at, now).ok, `${at} at ${now}`).toBe(at > now && at <= now + MAX_DURATION);
    }
  });
});

describe("extend, as the vaults check it", () => {
  const current = NOW + 30 * DAY;

  it("needs a time later than the current unlock time", () => {
    expect(checkExtend(current, current, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.notLater });
    expect(checkExtend(current - 1, current, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.notLater });
    expect(checkExtend(current + 1, current, NOW)).toEqual({ ok: true, unlockAt: current + 1 });
  });

  it("keeps the window from now: never past MAX_DURATION from now, whatever the current time", () => {
    expect(checkExtend(NOW + MAX_DURATION, current, NOW).ok).toBe(true);
    expect(checkExtend(NOW + MAX_DURATION + 1, current, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.tooFar });
  });

  it("re-locks an expired lock only into the future", () => {
    const expired = NOW - 10 * DAY;
    expect(checkExtend(NOW - DAY, expired, NOW)).toEqual({ ok: false, error: UNLOCK_ERRORS.past });
    expect(checkExtend(NOW + DAY, expired, NOW)).toEqual({ ok: true, unlockAt: NOW + DAY });
  });

  it("agrees with `newUnlockAt > unlockAt` then the window, for any times (property)", () => {
    const r = random(2);
    for (let i = 0; i < RUNS; i++) {
      const now = r.int(1_700_000_000, 2_000_000_000);
      const cur = r.int(1_600_000_000, 2_200_000_000);
      const next = i % 2 ? r.int(1_600_000_000, 2_200_000_000) : cur + r.int(-3, 3);
      const contract = next > cur && next > now && next <= now + MAX_DURATION;
      expect(checkExtend(next, cur, now).ok, `${next} over ${cur} at ${now}`).toBe(contract);
    }
  });

  it("adds a preset to the later of the current unlock time and now", () => {
    expect(extendBase(current, NOW)).toBe(current);
    expect(extendBase(NOW - DAY, NOW)).toBe(NOW);
    expect(presetUnlock(extendBase(current, NOW), 30)).toBe(current + 30 * DAY);
  });
});

describe("presets and the date picker", () => {
  it("offers 30, 90, 180 and 365 days, each inside the window", () => {
    expect(PRESET_DAYS).toEqual([30, 90, 180, 365]);
    for (const days of PRESET_DAYS) expect(checkUnlock(presetUnlock(NOW, days), NOW).ok, String(days)).toBe(true);
  });

  it("reads a date as that day at now's local time of day, so a date 30 days out matches the 30-day preset", () => {
    const at = presetUnlock(NOW, 30);
    expect(unlockFromDate(dateValue(at), NOW)).toBe(at);
  });

  it("refuses what isn't a date", () => {
    for (const bad of ["", "2027-02-30", "2027-13-01", "27-02-01", "tomorrow", "2027-2-1"]) expect(unlockFromDate(bad, NOW), bad).toBeNull();
  });

  it("bounds the picker to tomorrow through the last day inside MAX_DURATION", () => {
    const { min, max } = dateBounds(NOW);
    expect(min).toBe(dateValue(NOW + DAY));
    expect(checkUnlock(unlockFromDate(min, NOW), NOW).ok).toBe(true);
    expect(checkUnlock(unlockFromDate(max, NOW), NOW).ok).toBe(true);
    // The day after the last one offered is out of the window.
    const next = new Date(`${max}T12:00:00`);
    next.setDate(next.getDate() + 1);
    expect(checkUnlock(unlockFromDate(dateValue(Math.floor(next.getTime() / 1000)), NOW), NOW).ok).toBe(false);
  });

  it("starts an Extend's picker after the current unlock time", () => {
    const current = NOW + 10 * DAY + 3600;
    const { min } = dateBounds(NOW, current);
    expect(checkExtend(unlockFromDate(min, NOW), current, NOW).ok).toBe(true);
  });

  it("offers no day at all when a lock already runs as long as allowed (min after max)", () => {
    const { min, max } = dateBounds(NOW, NOW + MAX_DURATION);
    expect(min > max).toBe(true);
  });
});

describe("the amount", () => {
  it("must be a number in the token's decimals, more than zero, and no more than the balance", () => {
    expect(checkAmount("", 18, 10n)).toEqual({ ok: false, error: "Enter an amount." });
    expect(checkAmount("0", 18, 10n)).toEqual({ ok: false, error: "The amount must be more than zero." });
    expect(checkAmount("abc", 18, 10n).ok).toBe(false);
    expect(checkAmount("1.0000001", 6, undefined)).toEqual({ ok: false, error: "At most 6 decimal places" });
    expect(checkAmount("2", 0, 1n)).toEqual({ ok: false, error: "That's more than your balance." });
    expect(checkAmount("1,000.5", 2, undefined)).toEqual({ ok: true, units: 100_050n });
    expect(checkAmount("1", 18, 10n ** 18n)).toEqual({ ok: true, units: 10n ** 18n });
  });
});

describe("the LP share, as lockToken takes it from a Uniswap v2 LP token", () => {
  it("is floor(amount * bps / 10000), and the vault receives the rest", () => {
    expect(lpSplit(10_000n, 50n)).toEqual({ fee: 50n, toVault: 9_950n });
    expect(lpSplit(199n, 50n)).toEqual({ fee: 0n, toVault: 199n }); // below 200 units the fee rounds to zero
    expect(lpSplit(200n, 50n)).toEqual({ fee: 1n, toVault: 199n });
    expect(lpSplit(9_999_999_999_999_999_999n, 50n)).toEqual({ fee: 49_999_999_999_999_999n, toVault: 9_950_000_000_000_000_000n });
  });

  it("never takes more than the share, and loses nothing (property)", () => {
    const r = random(3);
    for (let i = 0; i < RUNS; i++) {
      const amount = i % 3 ? r.big(2n ** 200n) : BigInt(r.int(0, 100_000));
      const bps = BigInt(r.int(0, 100));
      const { fee, toVault } = lpSplit(amount, bps);
      expect(fee + toVault).toBe(amount);
      expect(fee * 10_000n <= amount * bps).toBe(true);
      expect((fee + 1n) * 10_000n > amount * bps).toBe(true);
    }
  });
});

describe("Max", () => {
  it("leaves nothing back for an ordinary token", () => {
    expect(lockReserve("0x1111111111111111111111111111111111111111", 30n * 10n ** 18n)).toBe(0n);
  });

  it("leaves Arc's USDC the flat fee (rounded up to 6 decimals) and the gas reserve, since they share one balance", () => {
    expect(lockReserve(USDC, 30n * 10n ** 18n)).toBe(30_000_000n + USDC_GAS_RESERVE);
    expect(lockReserve(USDC.toLowerCase(), 10n ** 12n + 1n)).toBe(2n + USDC_GAS_RESERVE);
    expect(lockReserve(USDC, undefined)).toBe(USDC_GAS_RESERVE);
  });
});

describe("dates in words", () => {
  it("formats an unlock time in UTC, with the zone, as Vesting does", () => {
    expect(formatWhen(1_802_584_639)).toBe("14 Feb 2027, 05:57 UTC");
    expect(formatWhen(1_900_000_000)).toBe("17 Mar 2030, 17:46 UTC");
    expect(formatWhen(Number.NaN)).toBe("?");
  });

  it("says how long until a time", () => {
    expect(untilText(NOW + 92 * DAY + 5, NOW)).toBe("in 92 days");
    expect(untilText(NOW + 2 * DAY, NOW)).toBe("in 2 days");
    expect(untilText(NOW + DAY, NOW)).toBe("in 24 hours");
    expect(untilText(NOW + 2 * 3600, NOW)).toBe("in 2 hours");
    expect(untilText(NOW + 61, NOW)).toBe("in 2 minutes");
    expect(untilText(NOW + 1, NOW)).toBe("in 1 minute");
    expect(untilText(NOW, NOW)).toBe("now");
  });
});
