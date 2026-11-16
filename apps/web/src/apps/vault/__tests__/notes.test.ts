import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import type { PositionLock } from "../locks";
import { collectedText, lockStepText, lockedText, noteText, transferIssue } from "../notes";

const TA = getAddress("0xbff22091be481b41c8ca49862653aba216bac041");
const TB = getAddress("0xf4f40da2d2b7f0a2c5d2d3e113ddfbeb3ffdca5e");
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const OWNER = getAddress("0x7e57000000000000000000000000000000000001");
const VAULT = getAddress("0x011916e14b8399fec0109f3402d283c71250c33c");

const position = (over: Partial<PositionLock> = {}): PositionLock => ({
  vault: VAULT,
  owner: OWNER,
  pendingOwner: null,
  unlockAt: 1_900_000_000,
  kind: "position",
  manager: TA,
  managerName: "Uniswap v4",
  positionKind: "v4",
  tokenId: "7",
  feeShareBps: 200,
  currency0: TA,
  currency1: TB,
  symbol0: "VTB",
  symbol1: "VTA",
  decimals0: 18,
  decimals1: 6,
  liquidity: 1n,
  withdrawn: false,
  ...over,
});

describe("collectedText: what a collect paid, from the vault's events", () => {
  it("says what reached the owner and what ArcOS kept, in each currency's own decimals", () => {
    expect(
      collectedText(
        [
          { currency: TA, toOwner: 117_600_000_000_000_000n, toPlatform: 2_400_000_000_000_000n },
          { currency: TB, toOwner: 117_600n, toPlatform: 2_400n },
        ],
        position(),
      ),
    ).toBe("Collected 0.1176 VTB and 0.1176 VTA. ArcOS kept 0.0024 VTB and 0.0024 VTA.");
  });

  it("leaves out ArcOS's part when nothing was kept (the share was skipped), and native USDC reads as USDC", () => {
    expect(collectedText([{ currency: ZERO, toOwner: 10n ** 18n, toPlatform: 0n }], position({ currency0: ZERO, symbol0: "USDC" }))).toBe("Collected 1 USDC.");
  });

  it("says when there was nothing to collect", () => {
    expect(collectedText([], position())).toBe("There were no fees to collect.");
    expect(collectedText([{ currency: TA, toOwner: 0n, toPlatform: 0n }], position())).toBe("There were no fees to collect.");
  });

  it("counts units when the decimals are unknown", () => {
    expect(collectedText([{ currency: TB, toOwner: 5n, toPlatform: 0n }], position({ decimals1: null }))).toBe("Collected 5 units of VTA.");
  });
});

describe("noteText: what an action's row says once it is done", () => {
  const done = { result: "done" as const, hash: "0x01" as const, collected: [] };

  it("says each outcome plainly", () => {
    expect(noteText({ kind: "withdraw" }, done, position())).toBe("Withdrawn. The position is back in your wallet.");
    expect(noteText({ kind: "withdraw" }, done, { ...position(), kind: "token" } as never)).toBe("Withdrawn to your wallet.");
    expect(noteText({ kind: "transfer", to: TB }, done, position())).toBe("Done. 0xF4F4…Ca5E can now accept it in Vault.");
    expect(noteText({ kind: "accept" }, done, position())).toBe("You now own this vault.");
    expect(noteText({ kind: "collect" }, done, position())).toBe("There were no fees to collect.");
  });

  it("names the new unlock date an extend was sent with, not the one the list still shows", () => {
    expect(noteText({ kind: "extend", unlockAt: 1_950_000_000 }, done, position({ unlockAt: 1_900_000_000 }))).toBe("Extended. It now unlocks 17 Oct 2031, 10:40 UTC.");
  });

  it("says a cancelled handover is a cancel, not a handover", () => {
    expect(noteText({ kind: "cancel" }, done, position())).toBe("Handover cancelled. The vault stays yours.");
  });

  it("gives a failure's own sentence", () => {
    expect(noteText({ kind: "withdraw" }, { result: "failed", message: "You cancelled the request in your wallet." }, position())).toBe(
      "You cancelled the request in your wallet.",
    );
  });
});

describe("a lock's progress and result", () => {
  const token = { kind: "token" as const, label: "100 UNI-V2", approval: "100 UNI-V2", unlockAt: 1_900_000_000, fee: 30n * 10n ** 18n, token: { symbol: "UNI-V2", decimals: 18 } };
  const position_ = { kind: "position" as const, label: "Uniswap v4 #7", approval: "Uniswap v4 #7", unlockAt: 1_900_000_000, fee: 30n * 10n ** 18n };

  it("says what each step waits for, the approval for the whole amount the wallet asks for", () => {
    expect(lockStepText(token, "check", false)).toBe("Checking the fee and the approval…");
    expect(lockStepText(token, "approve", false)).toBe("Approve exactly 100 UNI-V2 for the vault factory in your wallet…");
    expect(lockStepText(position_, "approve", false)).toBe("Approve Uniswap v4 #7 for the vault factory in your wallet…");
    expect(lockStepText(token, "approve", true)).toBe("Waiting for the approval to confirm…");
    expect(lockStepText(token, "lock", false)).toBe("Confirm the lock in your wallet. It sends the 30 USDC fee.");
    expect(lockStepText(token, "lock", true)).toBe("Waiting for the lock to confirm…");
    expect(lockStepText(token, "find", false)).toBe("Your wallet answered with an error. Looking for the lock on chain, for up to a minute…");
  });

  it("says what reached the vault, from the factory's event: an LP token less ArcOS's share", () => {
    const locked = { result: "locked" as const, vault: VAULT, hash: "0x01" as const };
    expect(lockedText(token, { ...locked, amount: 99_500_000_000_000_000_000n })).toBe("99.5 UNI-V2 is in its vault until 17 Mar 2030, 17:46 UTC.");
    expect(lockedText(token, locked)).toBe("100 UNI-V2 is in its vault until 17 Mar 2030, 17:46 UTC.");
    expect(lockedText(position_, locked)).toBe("Uniswap v4 #7 is in its vault until 17 Mar 2030, 17:46 UTC.");
  });
});

describe("transferIssue", () => {
  const lock = { owner: OWNER, vault: VAULT };

  it("takes any other address", () => {
    expect(transferIssue(` ${TA} `, lock)).toBeNull();
    expect(transferIssue(TA.toLowerCase(), lock)).toBeNull();
  });

  it("refuses no address, the zero address, the owner and the vault itself", () => {
    expect(transferIssue("", lock)).toBe("Enter the new owner's address.");
    expect(transferIssue("0x12", lock)).toBe("Enter the new owner's address.");
    expect(transferIssue(ZERO, lock)).toBe("The new owner can't be the zero address.");
    expect(transferIssue(OWNER.toLowerCase(), lock)).toBe("That's already the owner.");
    expect(transferIssue(VAULT, lock)).toBe("That's the vault itself.");
  });
});
