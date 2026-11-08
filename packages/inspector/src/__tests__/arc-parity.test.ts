import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAINS } from "@arcos/chain";
import { SCENARIOS, capture, type Capture } from "./fixtures/arc-parity";

/**
 * Arc reads exactly as it did before the engine took its chain from the registry (`InspectChain`, `chainInput`).
 * fixtures/arc-parity.golden.json was written by the engine at 5727fc3, before that change, from the scenarios in
 * fixtures/arc-parity.ts with Arc's registry entries as input (which that engine only read for `dex`, `knownLockers`,
 * `explorerBase` and `arcosTokenFactory`). Each scenario must give the same report, byte for byte once the report's new
 * `chain` and `chainId` are set aside, and make the same calls to the chain: the same reads, the same multicalls, and the
 * same trade simulations with the same gas price, state override and amounts.
 *
 * Never regenerate the golden file to make this pass: a difference here is a change in what Arc's reports say.
 */
const golden = JSON.parse(readFileSync(new URL("./fixtures/arc-parity.golden.json", import.meta.url), "utf8")) as Record<string, Capture>;

describe("Arc parity: the same reports and the same chain calls as before the chain registry", () => {
  // A scenario where a check throws logs it (see `guard`); that line is not part of what is compared.
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("has a golden capture for every scenario, and no other", () => {
    expect(Object.keys(golden).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { report, calls } = await capture(scenario);
      const { chain, chainId, ...rest } = report;
      expect({ chain, chainId }).toEqual({ chain: "arc", chainId: CHAINS[scenario.network].id });
      expect(JSON.stringify(rest)).toBe(JSON.stringify(golden[scenario.name]!.report));
      expect(calls).toEqual(golden[scenario.name]!.calls);
    });
  }
});
