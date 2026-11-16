import { erc20Abi, type PublicClient } from "viem";
import { arcVestingAbi, vestingFactoryAbi, type Address } from "@arcos/chain";

/**
 * Where a vesting wallet's token comes from. The wallet doesn't keep it, and VestingFactory has no view for it, so it is
 * read from the factory's VestingCreated event, in the block the wallet was created in. This module is the only place
 * that knows how: if the factory gains a `tokenOf(wallet)` view, `resolveTokens` and `confirmToken` are what change.
 */

type Reader = Pick<PublicClient, "getCode" | "getContractEvents" | "readContract">;

/** Remembers which token each wallet was made for. */
export type TokenCache = { get(wallet: string): Address | undefined; set(wallet: string, token: Address): void };

const lower = (a: string) => a.toLowerCase();

/** Wallets whose lookup failed in this session: not searched again on every refresh. Cleared by a reload or `forgetFailed`. */
const failed = new Set<string>();
export const forgetFailed = (): void => failed.clear();

/**
 * The token a wallet was created for, or null when it can't be found: bisects `[from, to]` for the first block in which
 * `wallet` has code, then reads the factory's VestingCreated events in that block alone and takes the one for this
 * wallet's own address (so a wallet that was handed over, whose beneficiary is someone else, is found just the same).
 */
export async function findToken(client: Reader, factory: Address, wallet: Address, from: bigint, to: bigint): Promise<Address | null> {
  try {
    const hasCode = async (n: bigint) => {
      const code = await client.getCode({ address: wallet, blockNumber: n });
      return code !== undefined && code !== "0x";
    };
    if (!(await hasCode(to))) return null;
    let lo = from;
    let hi = to; // invariant: the wallet has code at `hi`
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1n;
    }
    const logs = await client.getContractEvents({ address: factory, abi: vestingFactoryAbi, eventName: "VestingCreated", fromBlock: hi, toBlock: hi });
    return logs.find((l) => l.args.vesting !== undefined && lower(l.args.vesting) === lower(wallet))?.args.token ?? null;
  } catch {
    return null;
  }
}

/**
 * The tokens of `wallets` (the ones the caller still needs): from the cache, else found by `findToken`, four at a time.
 * A wallet that can't be found is remembered as failed for the session. `failedAny` is true when some wallet is left
 * without a token, this time or before.
 */
export async function resolveTokens(
  client: Reader,
  opts: { factory: Address; wallets: readonly Address[]; fromBlock: bigint | null; latest: bigint; cache?: TokenCache },
): Promise<{ tokens: Map<string, Address>; failedAny: boolean }> {
  const { factory, wallets, fromBlock, latest, cache } = opts;
  const tokens = new Map<string, Address>();
  let failedAny = false;
  const todo: Address[] = [];
  for (const w of wallets) {
    const cached = cache?.get(w);
    if (cached) tokens.set(lower(w), cached);
    else if (failed.has(lower(w))) failedAny = true;
    else todo.push(w);
  }
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    const found = await Promise.all(batch.map((w) => findToken(client, factory, w, fromBlock ?? 0n, latest)));
    batch.forEach((w, j) => {
      const token = found[j];
      if (token) {
        tokens.set(lower(w), token);
        cache?.set(w, token);
      } else {
        failed.add(lower(w));
        failedAny = true;
      }
    });
  }
  return { tokens, failedAny };
}

/**
 * Whether `token` is the token of `wallet`, as a sentence when it can't be confirmed, or null when it can. Confirmed when
 * the wallet holds some of it or has released some, or when the factory's own creation event for the wallet names it.
 */
export async function confirmToken(client: Reader, factory: Address, wallet: Address, token: Address, latest: bigint, fromBlock: bigint | null): Promise<string | null> {
  try {
    const [held, released] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      client.readContract({ address: wallet, abi: arcVestingAbi, functionName: "released", args: [token] }),
    ]);
    if (held > 0n || released > 0n) return null;
    const found = await findToken(client, factory, wallet, fromBlock ?? 0n, latest);
    if (found === null) return "Couldn't confirm that token for this contract: it holds none of it and has released none.";
    return lower(found) === lower(token) ? null : "That isn't the token this schedule was made for.";
  } catch {
    return "Couldn't confirm that token for this contract. Check the address and try again.";
  }
}
