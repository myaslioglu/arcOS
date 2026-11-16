import { erc20Abi, getAddress, isAddress, type PublicClient } from "viem";
import { arcVestingAbi, vestingFactoryAbi, type Address } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { shortAddress } from "@/lib/format";

/**
 * Reading a beneficiary's vesting wallets. `VestingFactory.vestingsOf(user)` lists the wallets made FOR the user, but a
 * wallet's ownership can move after it was made (OpenZeppelin's Ownable, one step), so each wallet's own `owner()` is
 * the truth. A wallet the user no longer owns is left out of the list and counted; one the user came to own (bought, or
 * handed over) isn't in `vestingsOf` at all, so the window lets them add it by address. A wallet doesn't keep its token
 * either: it comes from the factory's `VestingCreated` event, or from the person when the lookup fails.
 */

/** How many of a beneficiary's newest wallets one read loads, and how many more "Show more" adds. */
export const PAGE = 20;

export type TokenInfo = { symbol: string; decimals: number };

export type WalletView = {
  wallet: Address;
  /** Null when the token isn't known yet (the event lookup failed and the person hasn't named it). */
  token: Address | null;
  tokenInfo: TokenInfo | null;
  start: bigint;
  duration: bigint;
  /** Seconds, counted from `start` (the wallet's `cliff()` minus its `start()`). */
  cliff: bigint;
  /** `balanceOf(wallet) + released(token)`: what the schedule counts as its total. Null while the token is unknown. */
  total: bigint | null;
  /** The wallet's own `vestedAmount(token, now)`. */
  vested: bigint | null;
  released: bigint | null;
  /** The wallet's own `releasable(token)`. */
  releasable: bigint | null;
  /** Where the wallet came from: made for the user, or added by the user by address. */
  source: "made" | "added";
};

export type VestingsData = {
  /** The chain's time when the numbers were read, in seconds. */
  now: bigint;
  /** How many wallets were made for the user, in all. */
  madeCount: number;
  wallets: WalletView[];
  /** Wallets made for the user whose owner is now someone else. */
  transferred: Address[];
  /** True when some wallet's token couldn't be found, so it shows no amounts until the person names it. */
  tokenLookupFailed: boolean;
  /** True when there are older wallets than the ones loaded. */
  hasMore: boolean;
};

export type AddedWallet = { wallet: Address; token: Address };

type Reader = Pick<PublicClient, "multicall" | "readContract" | "getContractEvents" | "getBlock" | "getCode">;

/** Remembers which token each wallet was made for. */
export type TokenCache = { get(wallet: string): Address | undefined; set(wallet: string, token: Address): void };

/**
 * The token a wallet was created for, or null when it can't be found: bisects `[from, to]` for the first block in which
 * `wallet` has code, then reads the factory's VestingCreated events (filtered to `beneficiary`) in that block alone.
 */
export async function findToken(client: Reader, factory: Address, beneficiary: Address, wallet: Address, from: bigint, to: bigint): Promise<Address | null> {
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
    const logs = await client.getContractEvents({ address: factory, abi: vestingFactoryAbi, eventName: "VestingCreated", args: { beneficiary }, fromBlock: hi, toBlock: hi });
    return logs.find((l) => l.args.vesting !== undefined && lower(l.args.vesting) === lower(wallet))?.args.token ?? null;
  } catch {
    return null;
  }
}

const lower = (a: string) => a.toLowerCase();

/** What `factory.isVesting(wallet)` and `wallet.owner()` say about a wallet a person wants to add, as a plain sentence or null if it's theirs. */
export async function checkAdded(client: Pick<PublicClient, "readContract">, factory: Address, user: Address, wallet: string, token: string): Promise<string | null> {
  if (!isAddress(wallet, { strict: false })) return "That isn't a vesting wallet address.";
  if (!isAddress(token, { strict: false })) return "That isn't a token address.";
  try {
    const made = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "isVesting", args: [getAddress(wallet)] });
    if (!made) return "ArcOS didn't create that wallet.";
    const owner = await client.readContract({ address: getAddress(wallet), abi: arcVestingAbi, functionName: "owner" });
    if (lower(owner) !== lower(user)) return "That wallet belongs to another address.";
    return null;
  } catch {
    return "Couldn't read that wallet. Check the address and try again.";
  }
}

export async function loadVestings(
  client: Reader,
  opts: { factory: Address; user: Address; count: number; fromBlock: bigint | null; added: readonly AddedWallet[]; cache?: TokenCache },
): Promise<VestingsData> {
  const { factory, user, count, fromBlock, added, cache } = opts;
  const block = await client.getBlock({ blockTag: "latest" });
  const now = block.timestamp;

  const madeCount = Number(await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "vestingsOfLength", args: [user] }));
  const from = Math.max(0, madeCount - count);
  const slice =
    madeCount === 0
      ? []
      : await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "vestingsOfSlice", args: [user, BigInt(from), BigInt(madeCount - from)] });
  // Newest first.
  const made = [...slice].reverse();

  // The token of each wallet. The wallet doesn't keep it, and Arc's RPC refuses an event query over more than 10,000
  // blocks, so each wallet's creation block is found first (the first block with code at its address, by bisection),
  // and the factory's VestingCreated event is read from that one block. A found token is remembered: it never changes.
  const tokens = new Map<string, Address>();
  let tokenLookupFailed = false;
  const unknown: Address[] = [];
  for (const w of made) {
    const cached = cache?.get(w);
    if (cached) tokens.set(lower(w), cached);
    else unknown.push(w);
  }
  if (unknown.length > 0) {
    const latest = block.number;
    const results: (Address | null)[] = [];
    for (let i = 0; i < unknown.length; i += 4) {
      results.push(...(await Promise.all(unknown.slice(i, i + 4).map((w) => findToken(client, factory, user, w, fromBlock ?? 0n, latest)))));
    }
    unknown.forEach((w, i) => {
      const token = results[i];
      if (token) {
        tokens.set(lower(w), token);
        cache?.set(w, token);
      } else tokenLookupFailed = true;
    });
  }
  for (const a of added) tokens.set(lower(a.wallet), a.token);

  const wanted: { wallet: Address; source: "made" | "added" }[] = [];
  const seen = new Set<string>();
  for (const w of made) {
    if (seen.has(lower(w))) continue;
    seen.add(lower(w));
    wanted.push({ wallet: w, source: "made" });
  }
  for (const a of added) {
    if (seen.has(lower(a.wallet))) continue;
    seen.add(lower(a.wallet));
    wanted.push({ wallet: a.wallet, source: "added" });
  }

  const terms = await client.multicall({
    allowFailure: true,
    contracts: wanted.flatMap(({ wallet }) => [
      { address: wallet, abi: arcVestingAbi, functionName: "owner" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "start" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "duration" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "cliff" } as const,
    ]),
  });

  type Base = { wallet: Address; source: "made" | "added"; start: bigint; duration: bigint; cliff: bigint; token: Address | null };
  const transferred: Address[] = [];
  const owned: Base[] = [];
  wanted.forEach((w, i) => {
    const [owner, start, duration, cliffAt] = terms.slice(i * 4, i * 4 + 4);
    if (owner.status !== "success" || start.status !== "success" || duration.status !== "success" || cliffAt.status !== "success") return;
    if (lower(owner.result as string) !== lower(user)) {
      if (w.source === "made") transferred.push(w.wallet);
      return;
    }
    const s = start.result as bigint;
    owned.push({ wallet: w.wallet, source: w.source, start: s, duration: duration.result as bigint, cliff: (cliffAt.result as bigint) - s, token: tokens.get(lower(w.wallet)) ?? null });
  });

  const withToken = owned.filter((o) => o.token !== null);
  const amounts = await client.multicall({
    allowFailure: true,
    contracts: withToken.flatMap(({ wallet, token }) => [
      { address: token!, abi: erc20Abi, functionName: "balanceOf", args: [wallet] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "released", args: [token!] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "vestedAmount", args: [token!, now] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "releasable", args: [token!] } as const,
    ]),
  });
  const uniqueTokens = [...new Set(withToken.map((o) => lower(o.token!)))].map((t) => withToken.find((o) => lower(o.token!) === t)!.token!);
  const meta = await client.multicall({
    allowFailure: true,
    contracts: uniqueTokens.flatMap((token) => [
      { address: token, abi: erc20Abi, functionName: "symbol" } as const,
      { address: token, abi: erc20Abi, functionName: "decimals" } as const,
    ]),
  });
  const infoOf = new Map<string, TokenInfo | null>();
  uniqueTokens.forEach((token, i) => {
    const [sym, dec] = meta.slice(i * 2, i * 2 + 2);
    const decimals = dec.status === "success" ? Number(dec.result) : null;
    infoOf.set(lower(token), decimals === null ? null : { symbol: (sym.status === "success" ? cleanLabel(sym.result as string, 32) : null) ?? shortAddress(token), decimals });
  });

  const amountsOf = new Map<string, { total: bigint | null; vested: bigint | null; released: bigint | null; releasable: bigint | null }>();
  withToken.forEach((o, i) => {
    const [balance, released, vested, releasable] = amounts.slice(i * 4, i * 4 + 4);
    const rel = released.status === "success" ? (released.result as bigint) : null;
    const bal = balance.status === "success" ? (balance.result as bigint) : null;
    amountsOf.set(lower(o.wallet), {
      total: rel !== null && bal !== null ? rel + bal : null,
      vested: vested.status === "success" ? (vested.result as bigint) : null,
      released: rel,
      releasable: releasable.status === "success" ? (releasable.result as bigint) : null,
    });
  });

  const wallets: WalletView[] = owned.map((o) => {
    const a = amountsOf.get(lower(o.wallet)) ?? { total: null, vested: null, released: null, releasable: null };
    return { ...o, tokenInfo: o.token ? (infoOf.get(lower(o.token)) ?? null) : null, ...a };
  });

  return { now, madeCount, wallets, transferred, tokenLookupFailed, hasMore: from > 0 };
}
