import { describe, expect, it, vi } from "vitest";

vi.mock("wagmi", () => ({ useConnection: () => ({}), usePublicClient: () => undefined, useWriteContract: () => ({ mutateAsync: async () => "0x" }) }));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({}) }));
vi.mock("@/providers/wagmi", () => ({ wagmiConfig: {} }));

import { VESTING_ERRORS, findCreated, readChainNow } from "../useCreate";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const ME = "0x2222222222222222222222222222222222222222" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;
const BEN = "0x3333333333333333333333333333333333333333" as const;
const W = "0x00000000000000000000000000000000000000a1" as const;
const row = { line: 1, address: BEN, amount: 5n };

function client(over: { after: bigint; logs: unknown[] }) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "vestingsOfLength" ? over.after : [W])),
    getContractEvents: vi.fn(async () => over.logs),
  } as never;
}

describe("findCreated (after a wallet error that may have followed a send)", () => {
  it("finds the schedule when the beneficiary's list grew with this creator's event", async () => {
    const c = client({ after: 3n, logs: [{ args: { vesting: W }, transactionHash: "0xabc" }] });
    expect(await findCreated(c, FACTORY, ME, TOKEN, row, 2n, 10n)).toEqual({ status: "created", hash: "0xabc", vesting: W });
  });
  it("finds nothing when the list did not grow, or grew without a matching event, or the read fails", async () => {
    expect(await findCreated(client({ after: 2n, logs: [] }), FACTORY, ME, TOKEN, row, 2n, 10n)).toBeNull();
    expect(await findCreated(client({ after: 3n, logs: [{ args: { vesting: "0x00000000000000000000000000000000000000b2" }, transactionHash: "0x1" }] }), FACTORY, ME, TOKEN, row, 2n, 10n)).toBeNull();
    const broken = { readContract: async () => { throw new Error("rpc"); }, getContractEvents: async () => [] } as never;
    expect(await findCreated(broken, FACTORY, ME, TOKEN, row, 2n, 10n)).toBeNull();
  });
});

describe("readChainNow", () => {
  it("is the latest block's timestamp, not the browser's clock", async () => {
    const getBlock = vi.fn(async () => ({ timestamp: 1_234n }));
    expect(await readChainNow({ getBlock } as never)).toBe(1_234n);
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });
});

describe("the vesting sentences", () => {
  it("words ZeroAmount for a token that delivered nothing, not for a batch", () => {
    expect(VESTING_ERRORS.ZeroAmount).toMatch(/delivered nothing/);
    expect(VESTING_ERRORS.ZeroAmount).not.toMatch(/batch/);
  });
});
