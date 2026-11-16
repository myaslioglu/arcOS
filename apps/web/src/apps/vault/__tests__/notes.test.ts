import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import type { PositionLock } from "../locks";
import { collectedText, noteText, transferIssue } from "../notes";

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
    expect(noteText("extend", done, position({ unlockAt: 1_900_000_000 }))).toMatch(/^Extended\. It now unlocks .+2030.*\.$/);
    expect(noteText("withdraw", done, position())).toBe("Withdrawn. The position is back in your wallet.");
    expect(noteText("withdraw", done, { ...position(), kind: "token" } as never)).toBe("Withdrawn to your wallet.");
    expect(noteText("transfer", done, position())).toBe("Done. The new owner can now accept it in Vault.");
    expect(noteText("accept", done, position())).toBe("You now own this vault.");
    expect(noteText("collect", done, position())).toBe("There were no fees to collect.");
  });

  it("gives a failure's own sentence", () => {
    expect(noteText("withdraw", { result: "failed", message: "You cancelled the request in your wallet." }, position())).toBe(
      "You cancelled the request in your wallet.",
    );
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
