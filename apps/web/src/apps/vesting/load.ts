import { erc20Abi, getAddress, isAddress, zeroAddress, type PublicClient } from "viem";
import { arcVestingAbi, vestingFactoryAbi, type Address } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { shortAddress } from "@/lib/format";

/**
 * Reading a beneficiary's vesting wallets. `VestingFactory.vestingsOf(user)` lists the wallets made FOR the user, but a
 * wallet's ownership can move after it was made (OpenZeppelin's Ownable, one step), so each wallet's own `owner()` is
 * the truth. A wallet the user no longer owns is left out of the list and counted; one the user came to own (bought, or
 * handed over) isn't in `vestingsOf` at all, so the window lets them add it by address. A wallet doesn't keep its token:
 * the factory's `tokenOf(wallet)` does, written when the wallet was made. It is read in the same multicall as each
 * wallet's terms, and it is the zero address for anything the factory didn't create, which is then never listed.
 */

/** How many of a beneficiary's newest wallets one read loads, and how many more "Show more" adds. */
export const PAGE = 20;

export type TokenInfo = { symbol: string; decimals: number };

export type WalletView = {
  wallet: Address;
  /** The token the wallet was made for: the factory's `tokenOf(wallet)`. */
  token: Address;
  /** Null when the token's decimals can't be read. */
  tokenInfo: TokenInfo | null;
  start: bigint;
  duration: bigint;
  /** Seconds, counted from `start` (the wallet's `cliff()` minus its `start()`). */
  cliff: bigint;
  /** `balanceOf(wallet) + released(token)`: what the schedule counts as its total. Null when it couldn't be read. */
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
  /** True when there are older wallets than the ones loaded. */
  hasMore: boolean;
};

/** A wallet a person added by address. Its token isn't kept with it: `tokenOf` gives it when the list is read. */
export type AddedWallet = { wallet: Address };

type Reader = Pick<PublicClient, "multicall" | "readContract" | "getBlock">;

const lower = (a: string) => a.toLowerCase();

/**
 * What `factory.isVesting(wallet)` and `wallet.owner()` say about a wallet a person wants to add, as a plain sentence,
 * or null if ArcOS made it and it is theirs. Its token is the factory's `tokenOf(wallet)`, read with the list.
 */
export async function checkAdded(client: Pick<PublicClient, "readContract">, factory: Address, user: Address, wallet: string): Promise<string | null> {
  if (!isAddress(wallet, { strict: false })) return "That isn't a vesting wallet address.";
  const w = getAddress(wallet);
  try {
    const made = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "isVesting", args: [w] });
    if (!made) return "ArcOS didn't create that wallet.";
    const owner = await client.readContract({ address: w, abi: arcVestingAbi, functionName: "owner" });
    if (lower(owner) !== lower(user)) return "That wallet belongs to another address.";
    return null;
  } catch {
    return "Couldn't read that wallet. Check the address and try again.";
  }
}

export async function loadVestings(
  client: Reader,
  opts: { factory: Address; user: Address; count: number; added: readonly AddedWallet[] },
): Promise<VestingsData> {
  const { factory, user, count, added } = opts;
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

  // Each wallet's terms and its token, every wallet of the list in one multicall.
  const terms = await client.multicall({
    allowFailure: true,
    contracts: wanted.flatMap(({ wallet }) => [
      { address: wallet, abi: arcVestingAbi, functionName: "owner" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "start" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "duration" } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "cliff" } as const,
      { address: factory, abi: vestingFactoryAbi, functionName: "tokenOf", args: [wallet] } as const,
    ]),
  });

  type Base = { wallet: Address; source: "made" | "added"; token: Address; start: bigint; duration: bigint; cliff: bigint };
  const transferred: Address[] = [];
  const owned: Base[] = [];
  wanted.forEach((w, i) => {
    const answers = terms.slice(i * 5, i * 5 + 5);
    if (answers.some((a) => a.status !== "success")) return;
    const [owner, start, duration, cliffAt, tokenOf] = answers.map((a) => a.result);
    // No token: the factory didn't make this address (an added one from another factory, say), so it isn't listed.
    if (lower(tokenOf as string) === zeroAddress) return;
    if (lower(owner as string) !== lower(user)) {
      if (w.source === "made") transferred.push(w.wallet);
      return;
    }
    const s = start as bigint;
    owned.push({ wallet: w.wallet, source: w.source, token: getAddress(tokenOf as string), start: s, duration: duration as bigint, cliff: (cliffAt as bigint) - s });
  });

  const amounts = await client.multicall({
    allowFailure: true,
    contracts: owned.flatMap(({ wallet, token }) => [
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "released", args: [token] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "vestedAmount", args: [token, now] } as const,
      { address: wallet, abi: arcVestingAbi, functionName: "releasable", args: [token] } as const,
    ]),
  });
  const uniqueTokens = [...new Set(owned.map((o) => lower(o.token)))].map((t) => owned.find((o) => lower(o.token) === t)!.token);
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
  owned.forEach((o, i) => {
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
    return { ...o, tokenInfo: infoOf.get(lower(o.token)) ?? null, ...a };
  });

  return { now, madeCount, wallets, transferred, hasMore: from > 0 };
}
