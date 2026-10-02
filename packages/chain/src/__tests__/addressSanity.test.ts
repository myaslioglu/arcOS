import { describe, expect, it } from "vitest";
import { checkArcosAddresses } from "../addressSanity";
import type { ArcosContracts } from "../addresses";

const A = "0x1111111111111111111111111111111111111111";
// Has letters, unlike an all-digit address — needed so its lowercase form actually differs from its
// checksummed one (checksumming only changes the case of a-f hex letters, so an all-digit address'
// lowercase and checksummed forms are identical, which would make the "not checksummed" test moot).
const B = "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD";
const C = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";

const contracts = (over: Partial<ArcosContracts> = {}): ArcosContracts => ({
  feeController: A,
  tokenFactory: B,
  multisend: C,
  ...over,
});

describe("checkArcosAddresses", () => {
  it("treats null (not deployed on this network yet) as a distinct, non-error outcome", () => {
    expect(checkArcosAddresses(null)).toEqual({ status: "not-deployed" });
  });

  it("passes three distinct, non-zero, checksummed addresses", () => {
    expect(checkArcosAddresses(contracts())).toEqual({ status: "ok" });
  });

  it("flags any address that's the zero address", () => {
    const result = checkArcosAddresses(contracts({ feeController: ZERO }));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.some((i) => /feeController/.test(i) && /zero/.test(i))).toBe(true);
  });

  it("flags a malformed address", () => {
    const result = checkArcosAddresses(contracts({ multisend: "0xnotanaddress" as ArcosContracts["multisend"] }));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.some((i) => /multisend/.test(i))).toBe(true);
  });

  it("flags two contracts sharing the same address", () => {
    const result = checkArcosAddresses(contracts({ multisend: A })); // same as feeController
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.some((i) => /distinct/.test(i))).toBe(true);
  });

  it("flags an address that isn't checksummed, even though it's structurally valid", () => {
    const result = checkArcosAddresses(contracts({ tokenFactory: B.toLowerCase() as ArcosContracts["tokenFactory"] }));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.some((i) => /tokenFactory/.test(i) && /checksum/.test(i))).toBe(true);
  });

  it("skips R1's contracts while they're absent or null", () => {
    expect(checkArcosAddresses(contracts({ vaultFactory: null, vestingFactory: null, proPass: null }))).toEqual({ status: "ok" });
    expect(checkArcosAddresses(contracts({ vaultFactory: undefined }))).toEqual({ status: "ok" });
  });

  it("checks R1's contracts once they're set", () => {
    const D = "0x4444444444444444444444444444444444444444";
    const E = "0x5555555555555555555555555555555555555555";
    const F = "0x6666666666666666666666666666666666666666";
    expect(checkArcosAddresses(contracts({ vaultFactory: D, vestingFactory: E, proPass: F }))).toEqual({ status: "ok" });
    expect(checkArcosAddresses(contracts({ vaultFactory: D, vestingFactory: null }))).toEqual({ status: "ok" });

    const zero = checkArcosAddresses(contracts({ proPass: ZERO }));
    expect(zero.status === "invalid" && zero.issues.some((i) => /proPass/.test(i) && /zero/.test(i))).toBe(true);

    const malformed = checkArcosAddresses(contracts({ vestingFactory: "0x123" as ArcosContracts["multisend"] }));
    expect(malformed.status === "invalid" && malformed.issues.some((i) => /vestingFactory/.test(i))).toBe(true);

    const unchecksummed = checkArcosAddresses(contracts({ vaultFactory: B.toLowerCase() as ArcosContracts["multisend"] }));
    expect(unchecksummed.status === "invalid" && unchecksummed.issues.some((i) => /vaultFactory/.test(i) && /checksum/.test(i))).toBe(true);

    const shared = checkArcosAddresses(contracts({ vaultFactory: D, proPass: D }));
    expect(shared.status === "invalid" && shared.issues.some((i) => /distinct/.test(i))).toBe(true);
    const sharedWithR0 = checkArcosAddresses(contracts({ vestingFactory: A }));
    expect(sharedWithR0.status === "invalid" && sharedWithR0.issues.some((i) => /distinct/.test(i))).toBe(true);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const result = checkArcosAddresses({ feeController: ZERO, tokenFactory: ZERO, multisend: C });
    expect(result.status).toBe("invalid");
    // Both feeController and tokenFactory are flagged as zero, AND as a duplicate of each other.
    expect(result.status === "invalid" && result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
