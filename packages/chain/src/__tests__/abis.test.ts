import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
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
});
