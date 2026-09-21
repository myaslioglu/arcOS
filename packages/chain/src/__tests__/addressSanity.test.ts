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

  it("reports every problem at once rather than stopping at the first", () => {
    const result = checkArcosAddresses({ feeController: ZERO, tokenFactory: ZERO, multisend: C });
    expect(result.status).toBe("invalid");
    // Both feeController and tokenFactory are flagged as zero, AND as a duplicate of each other.
    expect(result.status === "invalid" && result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
