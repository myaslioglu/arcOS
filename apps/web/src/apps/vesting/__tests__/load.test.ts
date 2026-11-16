import { describe, expect, it, vi } from "vitest";
import { checkAdded, loadVestings } from "../load";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const USER = "0x2222222222222222222222222222222222222222" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;
const TOKEN_B = "0x5555555555555555555555555555555555555555" as const;
const W1 = "0x00000000000000000000000000000000000000a1" as const;
const W2 = "0x00000000000000000000000000000000000000a2" as const;
const W3 = "0x00000000000000000000000000000000000000a3" as const;
const W4 = "0x00000000000000000000000000000000000000a4" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const E18 = 10n ** 18n;

type Call = { address: string; functionName: string; args?: readonly unknown[] };

/**
 * A chain of three wallets made for USER, all of TOKEN but W3, which is of TOKEN_B; W2 has since been handed to OTHER.
 * Each wallet: 1000 tokens, 100 released, 900 held. `tokens` is what the factory's `tokenOf` answers per wallet, zero
 * for anything it didn't make.
 */
function fakeClient(over: { owners?: Record<string, string>; made?: string[]; tokens?: Record<string, string>; failTokenOf?: string } = {}) {
  const made = over.made ?? [W1, W2, W3];
  const owners: Record<string, string> = { [W1]: USER, [W2]: OTHER, [W3]: USER, [W4]: USER, ...over.owners };
  const tokens: Record<string, string> = { [W1]: TOKEN, [W2]: TOKEN, [W3]: TOKEN_B, ...over.tokens };
  const answer = (c: Call): unknown => {
    const w = c.address.toLowerCase();
    switch (c.functionName) {
      case "owner": return owners[w];
      case "start": return 1_000n;
      case "duration": return 1_000n;
      case "cliff": return 1_400n;
      case "tokenOf": {
        if (c.address !== FACTORY) throw new Error("tokenOf is the factory's");
        const wallet = String(c.args?.[0]).toLowerCase();
        if (wallet === over.failTokenOf) throw new Error("reverted");
        return tokens[wallet] ?? ZERO;
      }
      case "balanceOf": return 900n * E18;
      case "released": return 100n * E18;
      case "vestedAmount": return 450n * E18;
      case "releasable": return 350n * E18;
      case "symbol": return w === TOKEN_B ? "TKB" : "TKN";
      case "decimals": return 18;
      default: throw new Error(`unexpected ${c.functionName}`);
    }
  };
  const multicall = vi.fn(async ({ contracts }: { contracts: Call[] }) =>
    contracts.map((c) => {
      try {
        return { status: "success" as const, result: answer(c) };
      } catch (error) {
        return { status: "failure" as const, error };
      }
    }),
  );
  const readContract = vi.fn(async ({ functionName, args }: Call) => {
    if (functionName === "vestingsOfLength") return BigInt(made.length);
    if (functionName === "vestingsOfSlice") return made.slice(Number((args as bigint[])[1]));
    if (functionName === "isVesting") return (args as string[])[0].toLowerCase() in tokens;
    if (functionName === "owner") return owners[W1];
    throw new Error(`unexpected ${functionName}`);
  });
  const getBlock = vi.fn(async () => ({ timestamp: 1_500n, number: 100n }));
  // A loader that searched history for a wallet's token would call these; nothing may.
  const getCode = vi.fn();
  const getContractEvents = vi.fn();
  return { client: { multicall, readContract, getBlock, getCode, getContractEvents } as never, multicall, readContract, getCode, getContractEvents };
}

/** The `tokenOf` calls of every multicall made, as [multicall index, wallet]. */
const tokenOfCalls = (multicall: ReturnType<typeof fakeClient>["multicall"]) =>
  multicall.mock.calls.flatMap(([{ contracts }], i) => contracts.filter((c) => c.functionName === "tokenOf").map((c) => [i, c.args?.[0]]));

describe("loadVestings", () => {
  it("lists the wallets the user still owns, newest first, with the wallet's own numbers and the token tokenOf names", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [] });
    expect(data.now).toBe(1_500n);
    expect(data.madeCount).toBe(3);
    expect(data.wallets.map((w) => [w.wallet, w.token])).toEqual([
      [W3, TOKEN_B],
      [W1, TOKEN],
    ]);
    expect(data.wallets[1]).toMatchObject({ tokenInfo: { symbol: "TKN", decimals: 18 }, start: 1_000n, duration: 1_000n, cliff: 400n, released: 100n * E18, vested: 450n * E18, releasable: 350n * E18 });
    expect(data.wallets[0].tokenInfo).toEqual({ symbol: "TKB", decimals: 18 });
    // total is what the contract counts: its balance plus what it has released
    expect(data.wallets[0].total).toBe(1000n * E18);
    expect(data.hasMore).toBe(false);
  });

  it("reads every wallet's token from the factory's tokenOf in the one multicall that reads their terms, and searches no history", async () => {
    const { client, multicall, getCode, getContractEvents } = fakeClient();
    await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [{ wallet: W4 }] });
    // Every wallet of the list, in the first multicall: the three made for the user and the added one.
    expect(tokenOfCalls(multicall)).toEqual([
      [0, W3],
      [0, W2],
      [0, W1],
      [0, W4],
    ]);
    expect(getCode).not.toHaveBeenCalled();
    expect(getContractEvents).not.toHaveBeenCalled();
    // The terms with their tokens, the amounts, and the tokens' names: three multicalls for the whole list.
    expect(multicall).toHaveBeenCalledTimes(3);
  });

  it("leaves out a wallet whose ownership moved, and says which", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [] });
    expect(data.transferred).toEqual([W2]);
    expect(data.wallets.some((w) => w.wallet === W2)).toBe(false);
  });

  it("pages: reads only the newest `count`", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 1, added: [] });
    expect(data.wallets.map((w) => w.wallet)).toEqual([W3]);
    expect(data.hasMore).toBe(true);
  });

  it("lists a wallet the user was handed, marked as added, with its token from tokenOf", async () => {
    // W4 was made for someone else and is now owned by USER; only W1 was made for USER.
    const { client } = fakeClient({ made: [W1], tokens: { [W4]: TOKEN_B } });
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [{ wallet: W4 }] });
    expect(data.wallets.map((w) => [w.wallet, w.source, w.token])).toEqual([
      [W1, "made", TOKEN],
      [W4, "added", TOKEN_B],
    ]);
    expect(data.transferred).toEqual([]);
  });

  it("does not list an added wallet the user doesn't own, or one the factory didn't make (tokenOf is zero)", async () => {
    const { client } = fakeClient();
    // W2 belongs to OTHER; W4 is the user's, but tokenOf knows nothing of it: another factory's, say.
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [{ wallet: W2 }, { wallet: W4 }] });
    expect(data.wallets.map((w) => w.wallet)).toEqual([W3, W1]);
  });

  it("leaves out a wallet whose token can't be read, and still lists the others", async () => {
    const { client } = fakeClient({ failTokenOf: W3 });
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [] });
    expect(data.wallets.map((w) => w.wallet)).toEqual([W1]);
  });

  it("keeps a wallet whose token's decimals can't be read, without amounts in its units", async () => {
    const { client, multicall } = fakeClient();
    const real = multicall.getMockImplementation()!;
    multicall.mockImplementation(async (args) => {
      const out = await real(args);
      return args.contracts.map((c, i) => (c.functionName === "decimals" && c.address === TOKEN_B ? { status: "failure" as const, error: new Error("no") } : out[i]));
    });
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, added: [] });
    expect(data.wallets.find((w) => w.wallet === W3)).toMatchObject({ token: TOKEN_B, tokenInfo: null });
    expect(data.wallets.find((w) => w.wallet === W1)?.tokenInfo).toEqual({ symbol: "TKN", decimals: 18 });
  });
});

describe("checkAdded", () => {
  it("takes a wallet ArcOS made that the user owns", async () => {
    const { client } = fakeClient();
    expect(await checkAdded(client, FACTORY, USER, W1)).toBeNull();
  });

  it("refuses malformed input, a wallet ArcOS didn't make and one owned by someone else", async () => {
    const { client } = fakeClient();
    expect(await checkAdded(client, FACTORY, USER, "0x12")).toMatch(/vesting wallet/);
    expect(await checkAdded(client, FACTORY, USER, W4)).toMatch(/didn't create/);
    expect(await checkAdded(client, FACTORY, OTHER, W1)).toMatch(/another address/);
  });

  it("says so when the wallet can't be read", async () => {
    const { client, readContract } = fakeClient();
    readContract.mockRejectedValue(new Error("rpc down"));
    expect(await checkAdded(client, FACTORY, USER, W1)).toMatch(/Couldn't read that wallet/);
  });
});
