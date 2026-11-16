import { erc20Abi, getAddress, isAddress, type PublicClient } from "viem";
import { arcVestingAbi, vestingFactoryAbi, type Address } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { shortAddress } from "@/lib/format";
import { confirmToken, resolveTokens, type TokenCache } from "./tokenSource";

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

export type { TokenCache };

const lower = (a: string) => a.toLowerCase();

/**
 * What `factory.isVesting(wallet)`, `wallet.owner()` and the token's own records say about a wallet a person wants to
 * add, as a plain sentence, or null if it's theirs and the token is confirmed.
 */
export async function checkAdded(
  client: Pick<PublicClient, "readContract" | "getBlock" | "getCode" | "getContractEvents">,
  factory: Address,
  user: Address,
  wallet: string,
  token: string,
  fromBlock: bigint | null = null,
): Promise<string | null> {
  if (!isAddress(wallet, { strict: false })) return "That isn't a vesting wallet address.";
  if (!isAddress(token, { strict: false })) return "That isn't a token address.";
  const w = getAddress(wallet);
  try {
    const made = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "isVesting", args: [w] });
    if (!made) return "ArcOS didn't create that wallet.";
    const owner = await client.readContract({ address: w, abi: arcVestingAbi, functionName: "owner" });
    if (lower(owner) !== lower(user)) return "That wallet belongs to another address.";
    const latest = (await client.getBlock({ blockTag: "latest" })).number;
    return await confirmToken(client, factory, w, getAddress(token), latest, fromBlock);
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

  const wanted: { wallet: Address; source: "made" | "added" }[] = [];
  const seen = new Set<string>();
  for (const w of [...slice].reverse()) {
    // Newest first.
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

  type Base = { wallet: Address; source: "made" | "added"; start: bigint; duration: bigint; cliff: bigint };
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
    owned.push({ wallet: w.wallet, source: w.source, start: s, duration: duration.result as bigint, cliff: (cliffAt.result as bigint) - s });
  });

  // Tokens are looked up for the wallets the user still owns, and only for those the person hasn't named.
  const tokens = new Map<string, Address>();
  for (const a of added) tokens.set(lower(a.wallet), a.token);
  const lookup = await resolveTokens(client, {
    factory,
    wallets: owned.filter((o) => !tokens.has(lower(o.wallet))).map((o) => o.wallet),
    fromBlock,
    latest: block.number,
    cache,
  });
  for (const [k, v] of lookup.tokens) tokens.set(k, v);
  const tokenLookupFailed = lookup.failedAny;
  const withToken = owned.filter((o) => tokens.has(lower(o.wallet))).map((o) => ({ ...o, token: tokens.get(lower(o.wallet))! }));

  const amounts = await client.multicall({
    allowFailure: true,
    contracts: withToken.flatMap(({ wallet, token }) => [
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "released", args: [token] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "vestedAmount", args: [token, now] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "releasable", args: [token] } as const,
    ]),
  });
  const uniqueTokens = [...new Set(withToken.map((o) => lower(o.token)))].map((t) => withToken.find((o) => lower(o.token) === t)!.token);
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
    const token = tokens.get(lower(o.wallet)) ?? null;
    const a = amountsOf.get(lower(o.wallet)) ?? { total: null, vested: null, released: null, releasable: null };
    return { ...o, token, tokenInfo: token ? (infoOf.get(lower(token)) ?? null) : null, ...a };
  });

  return { now, madeCount, wallets, transferred, tokenLookupFailed, hasMore: from > 0 };
}
