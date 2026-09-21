import { describe, expect, it } from "vitest";
import { keccak256, toBytes, toHex } from "viem";
import { FEE_KEYS, feeControllerAbi, multisendAbi, tokenFactoryAbi } from "../abis";

type AbiInput = { name?: string };
type AbiItem = { type: string; name?: string; inputs?: readonly AbiInput[] };

const names = (abi: readonly AbiItem[], type: string) =>
  abi.filter((item) => item.type === type).map((item) => item.name);

const findItem = (abi: readonly AbiItem[], type: string, name: string) =>
  abi.find((item) => item.type === type && item.name === name);

const inputNames = (item: AbiItem | undefined) => (item?.inputs ?? []).map((input) => input.name);

describe("abis", () => {
  it("feeControllerAbi exposes the functions the app calls", () => {
    const fns = names(feeControllerAbi, "function");
    expect(fns).toContain("feeOf");
    expect(fns).toContain("recipient");
  });

  it("feeControllerAbi's renounceOwnership is permanently disabled", () => {
    expect(names(feeControllerAbi, "error")).toContain("RenounceDisabled");
  });

  it("tokenFactoryAbi exposes the functions and events the app calls", () => {
    const fns = names(tokenFactoryAbi, "function");
    expect(fns).toContain("createToken");
    expect(fns).toContain("tokensOf");
    expect(names(tokenFactoryAbi, "event")).toContain("TokenCreated");
  });

  it("tokenFactoryAbi exposes the forever-usable registry paging functions", () => {
    const fns = names(tokenFactoryAbi, "function");
    expect(fns).toContain("tokenCountOf");
    expect(fns).toContain("tokensOfSlice");
  });

  it("tokenFactoryAbi's TokenCreated event carries a holder input", () => {
    const event = findItem(tokenFactoryAbi, "event", "TokenCreated");
    expect(inputNames(event)).toContain("holder");
  });

  it("multisendAbi exposes the functions and events the app calls", () => {
    const fns = names(multisendAbi, "function");
    expect(fns).toContain("quote");
    expect(fns).toContain("sendNative");
    expect(fns).toContain("sendToken");
    const events = names(multisendAbi, "event");
    expect(events).toContain("Drop");
    expect(events).toContain("TransferFailed");
  });

  it("multisendAbi's TransferFailed event carries an index input", () => {
    const event = findItem(multisendAbi, "event", "TransferFailed");
    expect(inputNames(event)).toContain("index");
  });

  it("multisendAbi's Drop event carries a failedCount input", () => {
    const event = findItem(multisendAbi, "event", "Drop");
    expect(inputNames(event)).toContain("failedCount");
  });

  it("FEE_KEYS.MINT_FLAT matches keccak256(toHex(\"MINT_FLAT\"))", () => {
    expect(FEE_KEYS.MINT_FLAT).toBe(keccak256(toHex("MINT_FLAT")));
  });

  // Each literal below is pinned next to its derivation, independent of abis.ts's own `key()` helper:
  // a re-derivation using the same helper the source uses would happily agree with an accidental
  // rename (e.g. FEE_KEYS.MINT_FLAT quietly changed to key("MINT_FEE")) instead of catching it. A
  // hardcoded literal, computed once and pasted here, can't drift with the source — only a real
  // rename of the string handed to `key(...)` in abis.ts changes what these keys hash to, and either
  // assertion below would then fail immediately.
  describe("FEE_KEYS literals are pinned, so a rename can't silently change a key", () => {
    it("MINT_FLAT", () => {
      expect(keccak256(toBytes("MINT_FLAT"))).toBe("0x7e3109370ea7d535d8e73c700691d5151250527d4c65ccdd66b01e32ec316812");
      expect(FEE_KEYS.MINT_FLAT).toBe("0x7e3109370ea7d535d8e73c700691d5151250527d4c65ccdd66b01e32ec316812");
    });

    it("DROP_PER_RECIPIENT", () => {
      expect(keccak256(toBytes("DROP_PER_RECIPIENT"))).toBe("0x7f20ba24d22838ff3f3d21fdec6fb343e1aca802a9d10ee9d2231b27d83c0125");
      expect(FEE_KEYS.DROP_PER_RECIPIENT).toBe("0x7f20ba24d22838ff3f3d21fdec6fb343e1aca802a9d10ee9d2231b27d83c0125");
    });

    it("DROP_MIN", () => {
      expect(keccak256(toBytes("DROP_MIN"))).toBe("0x3133bb54d476009314a9f209461af209ce01747eddd6f95a3dc60b73f245f8bb");
      expect(FEE_KEYS.DROP_MIN).toBe("0x3133bb54d476009314a9f209461af209ce01747eddd6f95a3dc60b73f245f8bb");
    });
  });
});
