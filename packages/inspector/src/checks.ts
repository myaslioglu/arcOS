/**
 * Check rules — when each answers "unknown" (a failed or missing read is never silently a "pass"):
 * - verified: the explorer didn't answer, or it answered without a record of this address (a 404)
 *   or without the field — only an explicit `is_verified: false` is the `fail`, since that finding
 *   tells a reader the deployer never published the source.
 * - ownership: owner()/getOwner() failed at the network level (a revert just means "try the next
 *   name"); or there's no owner function and the contract's logic code couldn't be read at all, so
 *   whether anyone controls it can't be told either way; or there's no owner function but the
 *   contract does have privileged functions (in logic code that WAS read), so who (if anyone) can
 *   call them can't be read; or owner() IS a burn address but the logic code couldn't be read, so
 *   role-based admins can't be ruled out. "Ownership is renounced" is reserved for a burn-address
 *   owner() on logic that WAS read and has no `grantRole`: with AccessControl in the code, a
 *   renounced Ownable leaves the roles untouched, so it's reported as role-based admin (a warn).
 * - privileges: the contract's logic code couldn't be read (see `LogicGap` — a clone, or an
 *   EIP-1967 or ZeppelinOS-style proxy, whose implementation is unreachable, points at empty code,
 *   is itself a proxy, or can't be picked out because its slots name two candidates); or
 *   privileged functions were found but the owner is unknown, or there's no owner function at all
 *   (can't tell if they're reachable either way). A proxy is always judged on its IMPLEMENTATION's
 *   bytecode and ABI, never on its own trampoline, which has no dispatcher and so would look
 *   privilege-free.
 * - proxy: the proxy slots are EIP-1967's and, read after them, the older ZeppelinOS ones that
 *   Circle's FiatToken proxies use; a ZeppelinOS-style proxy is judged exactly like an EIP-1967
 *   one. A storage-read failure on the top-level address propagates and is caught by the
 *   orchestrator's guard, so "Not a proxy" only ever rests on slots that were actually read; an
 *   EIP-1167 clone whose implementation couldn't be fetched at all (a transport failure) is
 *   unknown, never "not upgradeable"; a clone whose target read succeeded but came back with no
 *   code at all is a fail (it points at nothing); a resolved clone whose target is itself an
 *   upgradeable proxy is a fail ("Clone of an upgradeable proxy"), not a pass; a clone whose
 *   target's own proxy slots couldn't be read is unknown, because an unread slot is not an unset
 *   one; code that delegates calls (DELEGATECALL) but resolves to no known clone target or proxy
 *   slot is unknown, not "not a proxy".
 * - holders: the explorer didn't answer, total supply is unknown, or the holder list came back
 *   empty — which is never treated as "0% concentration" once total supply is known to be non-zero
 *   (a non-zero supply guarantees at least one holder exists), regardless of what the explorer's own
 *   holders-count field claims — or (with a DEX configured) pool discovery failed, so pools can't be
 *   excluded from the holder list; or the rows left after those exclusions are fewer than ten and
 *   the explorer confirms neither (through `next_page_params` nor through its own holders-count)
 *   that they are every holder there is, since a share added up from an unknown fraction of the
 *   holders is a floor, not a concentration figure — a floor can still be a warn or a fail, but
 *   never a pass.
 * - liquidity: no DEX is configured for this network, pool discovery failed at the network level,
 *   or every pool contract reverted (an address with no contract code does that, and inside a
 *   multicall answers 0x), which is never reported as "no pool found" — that would be a claim about
 *   pools made from a call that failed. The same goes for one family (Uniswap v2 and v3, Uniswap v4,
 *   Aerodrome) that never answered while another did: a liquid pool found elsewhere still passes, but
 *   "no pool" and "thin" wait for it. A v4 pool is liquid when a V4Quoter quote for 1,000 USDC out
 *   succeeds; the "in range" figure shown with it (see `quoteInRange`) decides nothing.
 * - lp-lock is the check from before the position index (`lpLockWithoutIndex`), and that check alone decides every
 *   pass and every unknown. Only Uniswap v2 has LP tokens to count. Unknown when no DEX is configured, pool discovery
 *   failed, the pool contracts never answered (or a family didn't and no pool was found), only pools other than
 *   Uniswap v2 exist, a pool of another kind may hold more than a burned pair, the v2 pair's LP totalSupply is zero
 *   (no evidence to compute a locked share from), or less than 95% of it is burned or locked on a chain whose lock
 *   contracts aren't vetted (`lockersVetted`), where the rest may sit in one. One thing it doesn't see, as before: a
 *   wallet's token-only range in a Uniswap v3 or Aerodrome pool beside a burned v2 pair holds no quote, so the pair
 *   still passes.
 * - lp-lock with the position index adds WARNINGS for Uniswap v4 liquidity, and nothing else: never a pass, never a
 *   fail (`tallyLiquidity`, lp-path.ts, `lpLockByPath`). Every pass, every fail and every unknown is the old check's,
 *   and so are its words, but for one thing. Three of its unknowns say positions "can't be read without an index yet"
 *   (`Unread`). Once an inspection had an index to read, those say instead what it read and what it didn't
 *   (`unreadDetail`): that it read who holds the v4 positions, found them under the warning's lines and still confirms
 *   no lock; or what stopped the reading; and, index or not, that v3 and Aerodrome positions aren't read. The reading
 *   runs when a v4 pool is involved and the index is fresh (`input.v4Positions`: mainnet, the index read, not switched
 *   off, its cursor within 10,000 blocks of the head). When it finds nothing to warn about, can't read the whole
 *   picture, or fails in any way (its reads outlast the inspection's deadline, a node refuses the index's tail,
 *   anything throws), the finding is the old check's. The old check is started first and runs beside it, with the time
 *   it always had. A warning replaces the old check's pass or unknown, never its fail.
 *   What it reads: every v4 position, live (`StateView.getPositionInfo`, the exact LiquidityAmounts math), classified
 *   by its holder, the PositionManager NFT's owner or else the address that holds it in the PoolManager
 *   (`classifyHolder`); every v2 pair split by LP-token holder; a v3 or Aerodrome pool's quote balance, nobody's in
 *   particular. Only a wallet's share (an address with no code) counts toward a warning. A burn address, a known
 *   locker, a contract (it may be a locker with terms of its own, a Safe, a launchpad or the pool's hook), a wallet in
 *   a pool whose hook runs on removal (the hook-address bits BEFORE_REMOVE_LIQUIDITY 1 << 9, AFTER_REMOVE_LIQUIDITY
 *   1 << 8, AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA 1 << 0: it can block or tax a withdrawal), v2 LP on a chain whose
 *   lock contracts aren't vetted, and a holder whose code wasn't read only make that share smaller.
 *   Pools are plain or not. Plain: a v2 pair, or a v4 pool with no hook that runs in swaps (BEFORE_SWAP 1 << 7,
 *   AFTER_SWAP 1 << 6 and their RETURNS_DELTA bits 1 << 3 and 1 << 2), a fixed LP fee of at most 1% (never the
 *   dynamic-fee flag 0x800000), and USDC or native USDC as the quote (EURC is no dollar, and no rate is read for
 *   it). In any other pool a wallet's position is still a wallet's, but whether a buyer or a seller ever reaches it
 *   is the pool's to decide, and putting it there costs nothing.
 *   Bids: the quote currency in the pools now (USDC, native USDC, and EURC 1:1), every pool, every class in the total
 *   (a v3 or Aerodrome pool's quote too, as nobody's).
 *   Asks: every position selling tokens above its pool's price, in every v2 and v4 pool, on one axis of what a buyer
 *   pays per token, which is the pool's price divided by one minus its LP fee: 0.3% in a v2 pair, slot0's `lpFee` in
 *   a v4 pool (for a dynamic-fee pool, the fee of the moment). The path starts at the cheapest ask of any pool; P1 is
 *   the price at which 1,000 units (`MIN_DEPTH`) have been paid in; the window runs to twice that price, and the
 *   shares of what has been paid in are read at P1, at the window's end and at every range edge in between. A path
 *   that never takes 1,000 units is one prefix, worded without a window.
 *   The warning, by title, each a statement of what was read:
 *   - "Wallets hold most of the USDC Inspector found in its pools": wallets in plain pools hold at least 1,000
 *     units of the bids, and more than half of all of them;
 *   - "Some liquidity isn't locked": wallets in plain pools take more than 5% at some prefix (up to all of it: the
 *     strong title is for money in the pools, never for tokens for sale, which are free and say where buyers' money
 *     goes only when the token's market is on the pools read), or hold more than 5% of
 *     the bids once the pools hold 1,000 units; or wallets, plain or not, take or hold half or more there (a wallet
 *     outside plain pools alone warns only from half); or wallets sell, beyond the window, a tenth or more of all the
 *     tokens for sale on the path (counted, never priced, and not measured against the supply).
 *   The detail starts "In the pools Inspector can read", gives the shares and amounts, never names a deployer (it is
 *   wallets, whoever's), and where a share rests only on wallets outside plain pools says so ("would go ..., if the
 *   hooks and fees of the pools selling it let buyers through"; bids "behind a swap hook, a dynamic or high fee, or
 *   in a pool not quoted in USDC, where nobody may be able to sell into it"). Burned or locked liquidity in such
 *   pools is given as that, apart. A finding leaves the path out when wallets take nothing on it. Up to 500 holders'
 *   code is read (`readHolderCode`: one state-overridden eth_call per 250, single reads when a node refuses that),
 *   largest first; a warning says so when the holders left unclassified could bring wallets to half.
 *   Why it never fails a token (a follow-up): tokens for sale are free and a pool's price is its creator's choice;
 *   quote parked under a price nobody sells at is at no risk (under a launch range holding the whole supply, no
 *   bid can ever be sold into); and a stranger's listing can stand beside another holder's money. A fail from
 *   positions needs the bids bounded by the tokens that could be sold into them, money matched to asks holder by
 *   holder and pro rata, or the deployer's identity.
 *   It says nothing (the old check answers) when: a family of pool contracts never answered; a v2 LP token's
 *   totalSupply is zero; the list of the token's pools was cut short (the index lists at most 50 and says when there
 *   are more, `extraPoolsTruncated`; discovery reads at most 50, `PoolScan.truncated`); a v4 pool of the token against
 *   a quote currency was created after the index's cursor and isn't among the pools found; or a v4 pool's positions
 *   can't be relied on (the index has no entry for it, lists more than 500 positions for it or 2,000 over the token's
 *   pools, lists positions whose in-range liquidity doesn't add up to the pool's active liquidity exactly, which means
 *   a gap in the index, or a position or an NFT's owner doesn't answer); and when anything stops it, as above.
 *   Which pools: discovery probes a token's standard hookless v4 keys; a pool with a hook or another fee is found only
 *   through the index (`extraPools`). The indexer's position step therefore records every v4 pool the PoolManager
 *   initialised since its deployment, on the same cursor as the positions, and the check reads `Initialize` over the
 *   blocks after that cursor with the token as currency0 and as currency1. Pools against a currency other than USDC,
 *   EURC or native USDC are not looked for and never counted, here as in every other check.
 *   Who can make which warning, and at what cost:
 *   - "most of the USDC": anyone who leaves at least 1,000 units, and more than everyone else holds, in a wallet's
 *     position in a plain pool. Parked far under the price, or under a launch range nobody can sell out of, it
 *     costs capital and risks nothing. It is true as stated: the USDC is there, and a wallet can withdraw it;
 *   - "some liquidity isn't locked": about 50 units' worth of tokens under the market in a plain pool; any tokens at
 *     any price in a new plain pool when the token's market isn't on the pools read (Uniswap v3 or Aerodrome, another
 *     currency or DEX, nothing left for sale), for gas, with a detail that begins by saying which pools it is about;
 *     a tenth of
 *     all the tokens for sale parked beyond the window; about 500 units' worth behind a hook that refuses swaps, or
 *     USDC there to half of the bids (both at no risk, and worded as depending on the hook); USDC above 5% of the
 *     bids anywhere in a plain pool.
 *   And who can avoid one, for gas: free tokens burned under a wallet's launch, in a plain pool or not, shrink its
 *   share; liquidity held in a pool that isn't plain gets the plain title at most; 51 empty pools or a flood of
 *   `ModifyLiquidity` in the index's tail stop the reading. None of this makes a pass.
 *   Also open: a finding is as of its block (nothing re-inspects a token when its price moves); v3 and Aerodrome
 *   positions aren't read; the in-range sum catches a missing position only while its range holds the current tick;
 *   a holder's code is read at the latest block; fees owed to a position aren't counted; the protocol fee isn't in
 *   the price a buyer pays; a hook's bits say when it runs, not what it does.
 *   Without an index (testnet; an inspection that couldn't fetch it; the indexer's `positions` switch off), with one
 *   more than 10,000 blocks behind the head (its backfill: a stale index can't say which pools there are), or with no
 *   v4 pool involved (none found, none created since the cursor, no pool list cut short), none of this runs. In the
 *   first two the old check's words stand, word for word. In the last the index was read, so only what they say of
 *   v3 and Aerodrome positions changes.
 * - prevrandao: the contract's logic code couldn't be read (the same `LogicGap` cases as
 *   privileges); a proxy's implementation bytecode is what gets scanned, never the trampoline's.
 * - trade: no DEX or no trade quote is configured, pool discovery failed, no USDC pool was found, or the round trip
 *   (see `checkTrade` and simulate.ts) didn't measure a sell: the buy reverted, a leg ran out of the
 *   gas it was given, nothing was spent, the pool paid nothing out, or the RPC refused, ignored or
 *   failed the state-overridden eth_call (or the gas price read). A `fail` takes a buy that went
 *   through and then either delivered no tokens of what the pool paid out, or a sell that reverted
 *   where only the token can have refused it (see `checkTrade`).
 *
 * On top of all of that, ownership, privileges and prevrandao are statements about code, so a
 * `pass` from any of them is conditional on the engine having seen the code that will actually run
 * — see `LogicBlock` and `gateLogicPass`. When the logic can be replaced (anything upgradeable), a
 * would-be pass becomes a `warn` naming who can replace it; when the scored code can run code from
 * elsewhere (DELEGATECALL), it becomes `unknown`. Their `fail`/`warn` findings describe the logic
 * running NOW and stand unchanged.
 */
import { parseAbi } from "viem";
import { BURN_ADDRESSES, type Address, type DexConfig } from "@arcos/chain";
import { usesOpcode } from "./bytecode";
import { SEVERE, type Privilege, type PrivilegeCategory } from "./privileges";
import type { ContractInfo, HolderPage } from "./explorer";
import { CallReverted, type ChainReader, type Finding, type InspectInput, type Pool, type PoolKey, type PoolScan, type PoolVersion } from "./types";
import { multicall, type BatchCall, type BatchResult } from "./multicall";
import { MAX_EXTRA_POOLS, readV4Pools, toSixDecimals, type V4Quote } from "./v4";
import {
  MAX_POSITIONS_PER_POOL, ReadsTimedOut, TAIL_MAX_BLOCKS, beforeDeadline, classifyHolder, hookCanChangeRemoval, readHolderCode, readV4Positions,
  v2TokenSqrtPrice, type PoolGap, type V4PoolRef,
} from "./v4-positions";
import { HOLDER_CLASSES, findPath, noSums, v2Ask, v4Ask, type Ask, type AskPath, type ClassSums, type HolderClass } from "./lp-path";
import { MIN_DEPTH, STATUS, buyDidNotTrade, poolCouldNotTrade, orderDepth, v2Out, poolCanRefuseSell, roundTripFee, simulateTrade, testAmountFor, tradeSetup, type TradeAttempt, type TradeSetup } from "./simulate";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ownableAbi = parseAbi(["function owner() view returns (address)", "function getOwner() view returns (address)"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const v2PairAbi = parseAbi(["function token0() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)"]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
/** Slipstream's factory keys a pool by tick spacing (an int24), where Uniswap v3's takes a fee. */
const aeroFactoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);

const FORWARDS_TO_UNIDENTIFIED_TITLE = "Forwards calls to unidentified code";
const FORWARDS_TO_UNIDENTIFIED_DETAIL =
  "The code contains a DELEGATECALL, but no EIP-1167 clone target, EIP-1967 proxy slot or ZeppelinOS proxy slot could be resolved.";

/**
 * Why the engine has no logic code to score. A proxy's own bytecode is a trampoline with no
 * function dispatcher, so scoring it would read "nothing privileged here" off the proxy instead of
 * off the code that actually runs — every one of these is `unknown`, never a pass. `null` means the
 * logic code WAS read.
 */
export type LogicGap = "logic-unreadable" | "logic-empty" | "logic-unidentified" | "logic-ambiguous";

const LOGIC_GAP: Record<LogicGap, { title: string; detail: string }> = {
  "logic-unreadable": { title: "Couldn't read the contract's logic", detail: "This contract runs another contract's code, and that code couldn't be read." },
  "logic-empty": { title: "Couldn't read the contract's logic", detail: "This contract forwards its calls to an address that has no contract code at all, so there's no logic to read." },
  "logic-unidentified": { title: "Couldn't read the contract's logic", detail: "This contract's logic sits behind a further proxy, so the code that actually runs couldn't be identified." },
  "logic-ambiguous": { title: "Couldn't read the contract's logic", detail: "This proxy's slots name two different places its logic could live — both of EIP-1967's slots, or an EIP-1967 slot and the ZeppelinOS one — and only its own bytecode decides which it runs, so which code to read can't be told." },
};

const ZERO = "0x0000000000000000000000000000000000000000";
const GRANT_ROLE = "0x2f2ff15d";
const ERC20_TRANSFER = "0xa9059cbb";
const lower = (a: string) => a.toLowerCase();
const isBurn = (a: string) => BURN_ADDRESSES.some((b) => lower(b) === lower(a));

/** `0x1234…abcd`. The web app has its own copy in `apps/web/src/lib/format.ts`; this package is a
 * leaf that never imports from an app, and one line is cheaper than a shared dependency for it. */
const shortAddress = (a: string): string => (a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);

/**
 * Why a would-be `pass` about what this contract's logic DOES can't stand, even though the check
 * found nothing wrong with the code it read.
 *
 * `mutable` (R1): the code can be replaced — this address's own proxy slots (EIP-1967's or
 * ZeppelinOS's) are set, or it is a clone of a contract whose are (exactly the condition
 * `checkProxy` fails on, read from the same value so the two can never disagree). "No privileged
 * functions", "Ownership is renounced", "No owner function" and "Doesn't rely on on-chain
 * randomness" are then statements about code that can be different tomorrow. They stay true of
 * the logic running NOW, which is why this downgrades to a `warn` naming who can replace it
 * rather than to an `unknown`.
 *
 * `delegatecall`: the code being scored can run code from another address, which this scan never
 * sees, so "nothing of the sort is in here" doesn't rule it out. Nothing is known about the code
 * that isn't visible, so this is `unknown`, and it outranks `mutable` — a UUPS implementation is
 * both, and "I can't see what it runs" is the stronger fact.
 *
 * `dispatcher` / `opcodes` (R2): the scan can't be shown to have read this contract at all — see
 * `dispatcherVisible`. `dispatcher` is the selector-scan form (a verified ABI declaring `transfer`
 * can stand in for the bytecode); `opcodes` is the form `prevrandao` uses, where only the bytecode
 * counts, because no ABI says anything about which instructions a contract contains. Both are
 * `unknown`, and both outrank `mutable` for the same reason.
 *
 * `forwards-unknown`: this address's own proxy slots couldn't be read, so whether the code being
 * scored is the code that runs was never established. It outranks everything: without that answer,
 * the rest is a reading of bytecode that may not be the bytecode in play.
 */
export type LogicBlock =
  | { kind: "forwards-unknown" }
  | { kind: "delegatecall" }
  | { kind: "dispatcher" }
  | { kind: "opcodes" }
  | { kind: "mutable"; admin: Address | null; proxy: Address; /** The current logic already exposes
      privileged functions (they just can't be called today), so an upgrade restores rather than
      adds. Only changes the wording. */ privileged: boolean };

/**
 * R2 — a scan is evidence of ABSENCE only if it can be shown to have seen this contract's
 * dispatcher. The thing being inspected is a token, so the test is ERC-20's own
 * `transfer(address,uint256)`: a scan that can't even see `transfer` has no standing to say whether
 * there is a `mint`. Vyper's dense dispatcher, Huff, a fallback-only contract and via-IR jump
 * tables all land here, as does `0x00`.
 */
export function dispatcherVisible(abi: readonly unknown[] | null, selectors: Set<string>): boolean {
  return dispatcherInBytecode(selectors) || abiDeclaresTransfer(abi);
}

/** The bytecode half: the dispatcher itself compares against the `transfer` selector. This is the
 * only half an OPCODE scan can use — an ABI describes functions and says nothing about what
 * instructions the contract contains. */
export function dispatcherInBytecode(selectors: Set<string>): boolean {
  return selectors.has(ERC20_TRANSFER);
}

/**
 * The explorer half: a published ABI that declares `transfer(address,uint256)` — the name AND the
 * argument types, mirroring exactly what the bytecode half matches. "Any non-empty ABI" was too
 * weak: a verified contract whose published ABI holds one unrelated function (or a stale, partial
 * one) would have stood as proof that the whole dispatcher had been read.
 */
export function abiDeclaresTransfer(abi: readonly unknown[] | null): boolean {
  if (abi === null) return false;
  return abi.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const entry = raw as { type?: unknown; name?: unknown; inputs?: unknown };
    if (entry.type !== "function" || entry.name !== "transfer" || !Array.isArray(entry.inputs)) return false;
    const types = entry.inputs.map((i) => (typeof i === "object" && i !== null ? (i as { type?: unknown }).type : null));
    return types.length === 2 && types[0] === "address" && types[1] === "uint256";
  });
}

/**
 * Short on purpose: the OG card gives a row ONE line at font size 30, which is about 43 characters
 * — the address and the reasoning go in `detail`. Two sets, because "added" understates logic that
 * already HAS privileged functions today and is merely held back by a renounced owner: an upgrade
 * there restores what is already written.
 */
const MUTABLE_TITLE: Record<"clean" | "privileged", Partial<Record<Finding["id"], string>>> = {
  clean: {
    ownership: "Control can be added by an upgrade",
    privileges: "Privileges can be added by an upgrade",
    prevrandao: "Randomness can be added by an upgrade",
  },
  privileged: {
    ownership: "Control can be restored by an upgrade",
    privileges: "Privileges can be restored by an upgrade",
    prevrandao: "Randomness can be added by an upgrade",
  },
};

const OPAQUE_LOGIC: Record<"forwards-unknown" | "delegatecall" | "dispatcher" | "opcodes", { title: string; detail: string }> = {
  "forwards-unknown": {
    title: "Couldn't tell if this contract forwards",
    detail: "This contract's EIP-1967 and ZeppelinOS proxy slots couldn't be read, so whether the code scanned here is the code that actually runs was never established.",
  },
  delegatecall: {
    title: "Runs code this check can't see",
    detail: "This contract can run code from another address (DELEGATECALL), which this check can't see — so what it found here rules nothing out.",
  },
  dispatcher: {
    title: "Couldn't read this contract's functions",
    detail: "No ERC-20 transfer function could be found in this contract's bytecode, and no verified ABI declares one, so this scan can't claim to have seen what it does or doesn't expose.",
  },
  opcodes: {
    title: "Couldn't read this contract's code",
    detail: "This doesn't read as an ERC-20's bytecode — the transfer function isn't in it — so what an opcode scan finds, or doesn't find, in it says nothing. A published ABI can't answer this one: it describes functions, not instructions.",
  },
};

/**
 * Applies a `LogicBlock` to a finding one of the three logic checks already produced. Only a
 * `pass` is ever rewritten: a `fail` or `warn` describes the logic running now and is still true,
 * and an `unknown` is already the weakest thing this engine says.
 */
export function gateLogicPass(input: InspectInput, finding: Finding, block: LogicBlock | null): Finding {
  if (block === null || finding.status !== "pass") return finding;
  if (block.kind === "mutable") {
    // No "But" here: the detail it is appended to may already contain one ("Found mint(...), but
    // ownership is renounced"), and two of them in one paragraph read as a correction of a
    // correction.
    const who = block.admin ? `The proxy admin ${shortAddress(block.admin)}` : "Whoever controls upgrades";
    return {
      ...finding,
      status: "warn",
      title: MUTABLE_TITLE[block.privileged ? "privileged" : "clean"][finding.id] ?? "An upgrade can change this",
      detail: `${finding.detail} ${who} can replace this contract's code, so that only describes the logic running now.`,
      evidenceUrl: `${input.explorerBase}/address/${block.proxy}?tab=contract`,
    };
  }
  const { title, detail } = OPAQUE_LOGIC[block.kind];
  return { ...finding, status: "unknown", title, detail };
}

/** Rounds to at most one decimal and drops a trailing ".0" — "30%", "50.4%", never "50.0%". */
const formatPct = (pct: number): string => {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

/** Swallows only `CallReverted` (the call reached the chain and said no); anything else propagates. */
async function catchReverted<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof CallReverted) return fallback;
    throw e;
  }
}

export type Owner =
  | { kind: "none" }
  | { kind: "renounced" }
  /** The logic exposes `grantRole`. `renounced` records that `owner()` is a burn address as well —
   * which says nothing about role holders, so it never reaches the "renounced" kind. */
  | { kind: "roles"; renounced: boolean }
  | { kind: "unknown" }
  | { kind: "wallet" | "contract"; address: Address };

export async function resolveOwner(reader: ChainReader, token: Address, selectors: Set<string>): Promise<Owner> {
  for (const fn of ["owner", "getOwner"]) {
    let owner: Address;
    try {
      owner = (await reader.read(token, ownableAbi, fn)) as Address;
    } catch (e) {
      if (e instanceof CallReverted) continue; // no such function — try the next name
      return { kind: "unknown" }; // a transport failure means nothing about ownership
    }
    // Renouncing Ownable retires owner-only functions; it does nothing to AccessControl, so a
    // contract with `grantRole` still has role holders who can call whatever the roles gate.
    if (isBurn(owner)) return selectors.has(GRANT_ROLE) ? { kind: "roles", renounced: true } : { kind: "renounced" };
    try {
      return { kind: (await reader.getCode(owner)) ? "contract" : "wallet", address: owner };
    } catch {
      return { kind: "unknown" };
    }
  }
  return selectors.has(GRANT_ROLE) ? { kind: "roles", renounced: false } : { kind: "none" };
}

/**
 * An EIP-1967 beacon proxy keeps its logic address behind `beacon.implementation()` (selector
 * 0x5c60da1b) rather than in a storage slot, so the beacon's own code is never the logic. Returns
 * null when the call reverts, the network doesn't answer, or the answer is the zero address —
 * "couldn't resolve it" is never evidence about what runs.
 */
export async function beaconImplementation(reader: ChainReader, beacon: Address | null): Promise<Address | null> {
  if (!beacon) return null;
  try {
    const impl = await reader.read(beacon, beaconAbi, "implementation");
    return typeof impl === "string" && lower(impl) !== ZERO ? (impl as Address) : null;
  } catch {
    return null;
  }
}

// MIN_DEPTH, 1,000 units of a 6-decimal quote token (what a pool must hold, or on v4 must pay out to a quote, to count as
// liquid), is defined in simulate.ts, which also orders the trade check's pools by it.

/** Distinguishes "the factory reverted" from "the factory answered the zero address". */
const REVERTED = Symbol("factory call reverted");

const VENUE: Record<PoolVersion, string> = { v2: "Uniswap v2", v3: "Uniswap v3", v4: "Uniswap v4", aero: "Aerodrome" };

/** "a", "a and b", "a, b and c" (or "or"). */
const listWith = (word: "and" | "or", items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;

/** The Uniswap versions a config reads, in order. */
const uniswapVersions = (dex: DexConfig): ("v2" | "v3" | "v4")[] => [
  ...(dex.v2Factory ? ["v2" as const] : []),
  ...(dex.v3Factory ? ["v3" as const] : []),
  ...(dex.v4 ? ["v4" as const] : []),
];

/** The v2 and v3 factories are one family: they were always asked together and read as answered together. */
const uniswapV2V3Name = (dex: DexConfig): string => `Uniswap ${listWith("and", [dex.v2Factory && "v2", dex.v3Factory && "v3"].filter((v): v is string => Boolean(v)))}`;

/**
 * What can be quoted against on v4: the config's quote tokens (6 decimals, USDC and EURC) and the chain's native currency
 * (`input.nativeQuote`, currency `address(0)`), when it has one: on Arc, native USDC with 18 decimals. A token is never its
 * own quote, and the native currency and its ERC-20 view (`nativeQuote.erc20View`, Arc's USDC at 0x3600) are one asset, so
 * inspecting that ERC-20 leaves out both forms of it.
 */
function v4Quotes(input: Pick<InspectInput, "address" | "nativeQuote">, dex: DexConfig): V4Quote[] {
  const token = lower(input.address);
  const quotes = dex.quoteTokens.filter((q) => lower(q.address) !== token).map((q) => ({ ...q, decimals: 6 }));
  const native = input.nativeQuote;
  const isNative = native !== null && (lower(native.address) === token || (native.erc20View !== null && lower(native.erc20View) === token));
  return native && !isNative ? [...quotes, { address: native.address, symbol: native.symbol, decimals: native.decimals }] : quotes;
}

/** Rejects if any call fails at the transport level — the caller decides what "pools unknown" means. */
export async function findPools(input: InspectInput): Promise<PoolScan> {
  const { dex, reader, address } = input;
  if (!dex) return { pools: [], factoriesAnswered: false, silent: [] };
  let uniswapAnswered = false;
  const askFactory = async (factory: Address, abi: typeof v2FactoryAbi | typeof v3FactoryAbi, fn: string, args: unknown[]): Promise<unknown> => {
    const answer = await catchReverted<unknown>(reader.read(factory, abi, fn, args), REVERTED);
    if (answer === REVERTED) return null;
    uniswapAnswered = true;
    return answer;
  };
  // A v2 pair's depth is its quote reserve, which is what it trades on, not its balance. Neither proves it trades: USDC
  // sent to a pair and `sync`ed gives it a quote reserve with no tokens beside it. So a pair counts as liquid only with
  // tokens in its reserves too, and a nonzero quote for the amount the trade check would buy with (`testAmountFor`); the
  // trade check itself moves on from a pool whose buy can't trade. A pair whose reserves can't be read has none.
  const v2Reserves = async (pair: Address, quote: Address): Promise<{ quote: bigint; token: bigint }> => {
    const [token0, reserves] = await Promise.all([
      catchReverted(reader.read(pair, v2PairAbi, "token0") as Promise<Address | null>, null),
      catchReverted(reader.read(pair, v2PairAbi, "getReserves") as Promise<readonly [bigint, bigint, number] | null>, null),
    ]);
    if (typeof token0 !== "string" || !Array.isArray(reserves)) return { quote: 0n, token: 0n };
    const [r0, r1] = [BigInt(reserves[0]), BigInt(reserves[1])];
    return lower(token0) === lower(quote) ? { quote: r0, token: r1 } : { quote: r1, token: r0 };
  };
  const add = async (pool: unknown, version: PoolVersion, quote: { address: Address; symbol: string }, fee?: number): Promise<Pool | null> => {
    if (typeof pool !== "string" || lower(pool) === ZERO) return null;
    if (version === "v2") {
      const reserves = await v2Reserves(pool as Address, quote.address);
      const depth = reserves.quote;
      // Only a pair with no tokens at all (USDC `sync`ed in) is left out of the trade check. One that holds tokens but quotes
      // nothing for the test amount is still traded against, and its buy reverting caps the finding (see `checkTrade`).
      const tradable = reserves.token > 0n;
      const liquid = depth >= MIN_DEPTH && tradable && v2Out(testAmountFor(depth), depth, reserves.token) > 0n;
      return { address: pool as Address, version, quote: quote.symbol, depth, liquid, tradable, tokenReserve: reserves.token };
    }
    const depth = await catchReverted(reader.read(quote.address, erc20Abi, "balanceOf", [pool]) as Promise<bigint>, 0n);
    return { address: pool as Address, version, quote: quote.symbol, depth, liquid: depth >= MIN_DEPTH, ...(fee === undefined ? {} : { fee }) };
  };
  // Uniswap v2 and v3 exist on mainnet only, so a network's config may leave either out: nothing is asked of a factory it
  // doesn't name, and v3 without fee tiers has no pool to look for.
  const { v2Factory, v3Factory, aero: aeroConfig } = dex;
  const v3Tiers = v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => ({ factory: v3Factory, fee })) : [];
  // A token is never its own quote: inspecting USDC or EURC skips that quote.
  const quotes = dex.quoteTokens.filter((quote) => lower(quote.address) !== lower(address));
  const perQuote = quotes.map(async (quote) => {
    const [v2Pool, v3Pools] = await Promise.all([
      v2Factory ? askFactory(v2Factory, v2FactoryAbi, "getPair", [address, quote.address]).then((pair) => add(pair, "v2", quote)) : null,
      Promise.all(
        v3Tiers.map(({ factory, fee }) =>
          askFactory(factory, v3FactoryAbi, "getPool", [address, quote.address, fee]).then((pool) => add(pool, "v3", quote, fee)),
        ),
      ),
    ]);
    return [v2Pool, ...v3Pools];
  });
  const v4 = dex.v4
    ? readV4Pools({ reader, v4: dex.v4, token: address, quotes: v4Quotes(input, dex), extra: input.extraPools ?? [], quoteUnits: MIN_DEPTH / 1_000_000n })
    : null;

  // Aerodrome Slipstream: the factory's `getPool` for every quote and every tick spacing the config lists, in one multicall
  // (12 questions would otherwise be 12 parallel requests), then the quote balance of each pool that exists, as for v3.
  const aeroAsks = aeroConfig
    ? quotes.flatMap((quote) =>
        aeroConfig.tickSpacings.map((spacing) => ({
          quote,
          call: { target: aeroConfig.clFactory, abi: aeroFactoryAbi, functionName: "getPool", args: [address, quote.address, spacing] } satisfies BatchCall,
        })),
      )
    : [];
  const aero = (async (): Promise<{ answered: boolean; pools: (Pool | null)[] }> => {
    if (aeroAsks.length === 0) return { answered: false, pools: [] };
    let answers: BatchResult[];
    try {
      answers = await multicall(reader, aeroAsks.map((ask) => ask.call));
    } catch (e) {
      if (e instanceof CallReverted) return { answered: false, pools: [] }; // the aggregate itself reverted: nothing was read
      throw e;
    }
    const pools = await Promise.all(
      aeroAsks.map((ask, i) => {
        const answer = answers[i]!;
        return answer.ok ? add(answer.value, "aero", ask.quote) : null;
      }),
    );
    return { answered: answers.some((a) => a.ok), pools };
  })();
  const [uniswapResults, v4Read, aeroRead] = await Promise.all([Promise.all(perQuote), v4, aero]);

  // A family whose contracts never answered says nothing about its pools. The answer that matters to a finding is whether
  // one exists, so each configured family is accounted for on its own.
  const families = [
    { name: uniswapV2V3Name(dex), configured: Boolean(v2Factory || v3Factory), answered: uniswapAnswered },
    { name: VENUE.v4, configured: Boolean(dex.v4), answered: v4Read?.answered ?? false },
    { name: VENUE.aero, configured: Boolean(aeroConfig), answered: aeroRead.answered },
  ];
  return {
    pools: [
      ...uniswapResults.flat().filter((p): p is Pool => p !== null),
      ...aeroRead.pools.filter((p): p is Pool => p !== null),
      ...(v4Read?.pools ?? []),
    ],
    factoriesAnswered: families.some((f) => f.configured && f.answered),
    silent: families.filter((f) => f.configured && !f.answered).map((f) => f.name),
    ...(v4Read?.truncated ? { truncated: true } : {}),
  };
}

const finding = (id: Finding["id"], status: Finding["status"], title: string, detail: string, extra: Partial<Finding> = {}): Finding => ({
  id, status, title, detail, evidenceUrl: null, fixAppId: null, ...extra,
});

/**
 * `contract` is `null` when the explorer couldn't be reached at all, and `contract.verified` is
 * `null` when it answered but has no record of this address (a 404) or didn't say either way.
 * Neither is "not verified": a `fail` here tells a reader the deployer never published the source,
 * so it has to rest on the explorer positively saying so.
 *
 * "Anyone can read what this contract does" is a claim about the code that RUNS, so for a proxy or
 * a clone it has to cover the implementation too. `logic` is `null` when this address runs its own
 * code, and otherwise says where the code that runs lives (`at`, `null` when the engine knows this
 * token forwards but couldn't identify where) and what the explorer has on it. A verified proxy in
 * front of unverified logic is the shape that made this matter: the reassuring line was true of 40
 * lines of forwarding code and false of everything behind it.
 */
export type LogicVerification = { at: Address | null; info: ContractInfo | null };

export function checkVerified(
  input: InspectInput,
  contract: ContractInfo | null,
  logic: LogicVerification | null = null,
  arcosTemplate: boolean | null = null,
): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  // Positive evidence from chain, not the explorer: the ArcOS TokenFactory marks only the tokens it deploys itself,
  // each from one of its fixed templates, and the templates are published with the factory's verified source. It
  // never covers code that forwards its calls, and a failed read (null) claims nothing.
  if (arcosTemplate === true && logic === null && input.arcosTokenFactory && contract?.verified !== true) {
    return finding("verified", "pass", "Source code is verified (through the ArcOS TokenFactory)", "The ArcOS TokenFactory created this token, and it can only deploy four fixed templates, whose source is part of its verified source. This address's own explorer page may still say it isn't verified.", { evidenceUrl: `${input.explorerBase}/address/${input.arcosTokenFactory}?tab=contract` });
  }
  if (contract === null) return finding("verified", "unknown", "Couldn't check source verification", "The explorer didn't answer.", { evidenceUrl: url });
  if (contract.verified === null) return finding("verified", "unknown", "Couldn't check source verification", "The explorer has no record of this contract yet.", { evidenceUrl: url });
  if (!contract.verified) return finding("verified", "fail", "Source code isn't verified", "Only bytecode is public, so its behaviour can't be read directly.", { evidenceUrl: url });
  if (logic === null) return finding("verified", "pass", "Source code is verified", "Anyone can read what this contract does.", { evidenceUrl: url });
  if (logic.at === null) {
    return finding("verified", "unknown", "Couldn't check source verification", "This address's own source is verified, but it forwards its calls to code that couldn't be identified — so what it actually runs may be anything.", { evidenceUrl: url });
  }
  const logicUrl = `${input.explorerBase}/address/${logic.at}?tab=contract`;
  if (logic.info === null || logic.info.verified === null) {
    return finding("verified", "unknown", "Couldn't check source verification", `This proxy's own source is verified, but whether ${logic.at} — the implementation it runs — is verified couldn't be checked.`, { evidenceUrl: logicUrl });
  }
  return logic.info.verified
    ? finding("verified", "pass", "Source code is verified", `Both this proxy and the implementation it runs (${logic.at}) are verified.`, { evidenceUrl: url })
    : finding("verified", "fail", "The code this proxy runs isn't verified", `The proxy's own source is verified, but the implementation it runs (${logic.at}) isn't — only its bytecode is public.`, { evidenceUrl: logicUrl });
}

/**
 * `found` is the union of ABI- and bytecode-derived privileges (see `combinePrivileges`), already
 * resolved by the caller — `null` when the contract's logic code couldn't be read at all (an
 * unfetchable clone target, or a DELEGATECALL to unidentified code). `found === null` must NOT be
 * treated the same as "logic read, nothing privileged found": when there's no owner() function and
 * the logic is unreadable, whether anyone controls the contract can't be told either way.
 */
export function checkOwnership(input: InspectInput, owner: Owner, found: Privilege[] | null): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=read_contract`;
  if (owner.kind === "unknown") return finding("ownership", "unknown", "Couldn't read the owner", "The network didn't answer the owner() call.", { evidenceUrl: url });
  if (owner.kind === "renounced") {
    // A burn-address owner() is only half the story: role-based admins live in the logic, and
    // `resolveOwner` can only rule them out from selectors it actually read. With no logic to
    // read, "nobody controls this" is a bigger claim than the evidence supports.
    return found === null
      ? finding("ownership", "unknown", "Couldn't read the contract's logic", "owner() is a burn address, but the contract's logic code couldn't be read, so whether anything else (a role, an admin) can still control it can't be told.", { evidenceUrl: url })
      : finding("ownership", "pass", "Ownership is renounced", "owner() is a burn address.", { evidenceUrl: url });
  }
  if (owner.kind === "none") {
    if (found === null) {
      return finding("ownership", "unknown", "Couldn't read the contract's logic", "The contract's logic code couldn't be read, so it can't tell whether anyone controls it.", { evidenceUrl: url });
    }
    return found.length > 0
      ? finding("ownership", "unknown", "No owner function, but privileges exist", "The contract exposes no owner() or getOwner(), but its code has privileged functions — who (if anyone) can call them can't be read.", { evidenceUrl: url })
      : finding("ownership", "pass", "No owner function", "The contract exposes no owner() or getOwner().", { evidenceUrl: url });
  }
  if (owner.kind === "roles") {
    const detail = owner.renounced
      ? "owner() is a burn address, so ownership is renounced — but the contract also uses AccessControl, and giving up Ownable revokes no roles. Role holders can't be listed from bytecode."
      : "Uses AccessControl; role holders can't be listed from bytecode.";
    return finding("ownership", "warn", "Role-based admin", detail, { evidenceUrl: url });
  }
  const ownerUrl = `${input.explorerBase}/address/${owner.address}`;
  return owner.kind === "wallet"
    ? finding("ownership", "warn", "Owned by a wallet", `${owner.address} controls owner-only functions.`, { evidenceUrl: ownerUrl })
    : finding("ownership", "warn", "Owned by a contract", `${owner.address} (a multisig, timelock or other contract) controls owner-only functions.`, { evidenceUrl: ownerUrl });
}

const PRIVILEGE_TITLE: Record<PrivilegeCategory, string> = {
  mint: "Owner can mint new supply",
  blacklist: "Owner can block wallets from trading",
  fees: "Owner can change transfer fees",
  limits: "Owner can change transaction limits",
  pause: "Owner can switch trading on or off",
};

/**
 * `found` is the union of ABI- and bytecode-derived privileges (see `combinePrivileges`),
 * already resolved by the caller — `null` when the logic code couldn't be read at all.
 */
export function checkPrivileges(input: InspectInput, found: Privilege[] | null, gap: LogicGap | null, owner: Owner): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=write_contract`;
  if (found === null) {
    const { title, detail } = LOGIC_GAP[gap ?? "logic-unreadable"];
    return finding("privileges", "unknown", title, detail, { evidenceUrl: url });
  }
  const list = found.map((p) => p.signature).join(", ");
  if (found.length === 0) return finding("privileges", "pass", "No privileged functions found", "No mint, blacklist, fee, limit or pause function in the dispatcher.", { evidenceUrl: url });
  if (owner.kind === "unknown") {
    return finding("privileges", "unknown", "Privileged functions found, owner unknown", `Found: ${list}.`, { evidenceUrl: url });
  }
  if (owner.kind === "renounced") {
    return finding("privileges", "pass", "Privileged functions can't be called", `Found ${list}, but ownership is renounced.`, { evidenceUrl: url });
  }
  if (owner.kind === "none") {
    return finding("privileges", "unknown", "Privileged functions, no owner function", `Found: ${list}.`, { evidenceUrl: url });
  }
  const worst = found.find((p) => SEVERE.includes(p.category)) ?? found[0]!;
  const status = SEVERE.includes(worst.category) ? "fail" : "warn";
  return finding("privileges", status, PRIVILEGE_TITLE[worst.category], `Found: ${list}.`, { evidenceUrl: url });
}

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** EIP-1967 admin slot: who may call `upgradeToAndCall` on a transparent proxy. Empty on a UUPS
 * proxy (the right lives in the implementation) and on a beacon proxy (it lives on the beacon). */
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
/**
 * The slots proxies used before EIP-1967, from ZeppelinOS: `keccak256("org.zeppelinos.proxy.implementation")` and
 * `keccak256("org.zeppelinos.proxy.admin")`. Circle's FiatToken proxies, EURC on Arc among them, still keep their
 * implementation and admin there. They are read exactly like the EIP-1967 slots, and after them.
 */
export const ZEPPELINOS_IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
export const ZEPPELINOS_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
/** Whose layout a proxy's slots follow: EIP-1967's, or ZeppelinOS's older one. */
export type ProxySlotKind = "eip1967" | "zeppelinos";
/**
 * An answer this engine can use at all: `null` or a bare `0x` (nodes answer a never-written slot
 * either way, and both mean "nothing in it"), or a full 32-byte word. Anything else — a truncated
 * value, a bare 20-byte address — is a malformed answer. It is not evidence that the slot is set,
 * and it is certainly not an address to read out of: taking the last 40 characters of `0x01` once
 * printed a proxy admin of "0x0x01". Callers treat it the same way they treat a read that threw.
 */
export const slotReadable = (v: string | null): boolean => v === null || v === "0x" || v.length === 66;
/** A slot that was read AND holds something. A malformed answer is neither set nor unset. */
export const slotSet = (v: string | null) => v !== null && v.length === 66 && /[1-9a-f]/i.test(v.slice(2));
/** The 20-byte address a 32-byte storage slot value points at, or null when the slot isn't set. */
export const addressFromSlot = (v: string | null): Address | null => (slotSet(v) ? (`0x${v!.slice(-40)}` as Address) : null);

export type ProxyResolution = {
  cloneOf: Address | null;
  /** Only meaningful when `cloneOf` is set: the clone's implementation code couldn't be fetched at
   * all — a transport failure, not evidence of anything. Never a pass. */
  cloneReadFailed: boolean;
  /** Only meaningful when `cloneOf` is set and `cloneReadFailed` is false: the read succeeded but
   * the target address has no code (`0x`) — a clone pointing at nothing, which is broken. */
  cloneTargetEmpty: boolean;
  /** Only meaningful when `cloneOf` is set: every one of the target's proxy slot reads (EIP-1967's
   * and ZeppelinOS's) answered. When they didn't, `upgradeable === false` means "not read", not
   * "not set", so the clone can't be called non-upgradeable. */
  targetSlotsRead: boolean;
  /** DELEGATECALL is present but resolves to no known clone target or proxy slot. */
  forwardsToUnidentifiedCode: boolean;
  /** The code finally scored as this token's logic contains a DELEGATECALL of its own. A clone is
   * not re-pointable, but "its logic can't be replaced" is a claim about the code that ends up
   * running, and whoever controls the address behind that DELEGATECALL controls exactly that. */
  logicDelegates: boolean;
  /** The code this token runs can be replaced: one of its own proxy slots (EIP-1967's implementation
   * or beacon slot, or ZeppelinOS's implementation slot) is set, or it is a clone of a contract
   * whose is. THE value — `checkProxy`'s upgradeability `fail` and R1's block on the logic checks
   * (`LogicBlock`) both read this one field, so the report can never say "upgradeable proxy" and
   * "ownership is renounced" side by side. */
  upgradeable: boolean;
  /** Whose layout the slots that make this upgradeable follow (EIP-1967 wins when both kinds are
   * set). It decides which admin slot `admin` was read from, and the wording. `null` when this
   * isn't upgradeable. */
  slotKind: ProxySlotKind | null;
  /** The admin slot (EIP-1967's, or ZeppelinOS's for a ZeppelinOS-style proxy) of whichever address
   * makes this upgradeable, when it holds one. `null` covers: not upgradeable, slot empty (UUPS or
   * beacon), slot unreadable, and both kinds of admin slot set to different accounts (or the
   * ZeppelinOS one unreadable) — they produce the same finding text ("whoever controls upgrades"),
   * because the one thing that must never be said is a name that wasn't read, or might not count. */
  admin: Address | null;
};

/** The wording for each kind of upgradeable proxy. EIP-1967's is the one this check always had. */
const UPGRADEABLE: Record<ProxySlotKind, { kind: string; title: string; admin: (admin: Address) => string; noAdmin: string }> = {
  eip1967: {
    kind: "an EIP-1967",
    title: "Upgradeable proxy",
    admin: (admin) => `${admin} holds the EIP-1967 admin slot and can replace this contract's logic.`,
    noAdmin: "Whoever controls the proxy admin can replace this contract's logic.",
  },
  zeppelinos: {
    kind: "a ZeppelinOS-style",
    title: "Upgradeable ZeppelinOS-style proxy",
    admin: (admin) => `${admin} holds the admin slot of this ZeppelinOS-style proxy and can replace this contract's logic.`,
    noAdmin: "Whoever controls this ZeppelinOS-style proxy's admin can replace this contract's logic.",
  },
};

export function checkProxy(input: InspectInput, r: ProxyResolution): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  if (r.cloneOf) {
    const targetUrl = `${input.explorerBase}/address/${r.cloneOf}`;
    if (r.cloneReadFailed) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone that forwards to ${r.cloneOf}, whose code couldn't be read.`, { evidenceUrl: targetUrl });
    }
    if (r.cloneTargetEmpty) {
      return finding("proxy", "fail", "Clone points at an address with no code", `An EIP-1167 clone of ${r.cloneOf}, which has no contract code at all — calls to it will fail.`, { evidenceUrl: targetUrl });
    }
    if (r.upgradeable) {
      const who = r.admin ? `whose admin ${r.admin} ` : "whoever controls it ";
      const { kind } = UPGRADEABLE[r.slotKind ?? "eip1967"];
      return finding("proxy", "fail", "Clone of an upgradeable proxy", `An EIP-1167 clone of ${r.cloneOf}, which is itself ${kind} upgradeable proxy — ${who}can replace what this token's logic actually delegates to.`, { evidenceUrl: targetUrl });
    }
    if (!r.targetSlotsRead) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone of ${r.cloneOf}, whose own EIP-1967 and ZeppelinOS proxy slots couldn't be read.`, { evidenceUrl: targetUrl });
    }
    if (r.logicDelegates) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone of ${r.cloneOf}, which can't be re-pointed — but the code it runs delegates calls to an address this check couldn't identify, and whoever controls that address controls what this token does.`, { evidenceUrl: targetUrl });
    }
    return finding("proxy", "pass", "Minimal proxy — not upgradeable", `An EIP-1167 clone of ${r.cloneOf}; its logic can't be replaced.`, { evidenceUrl: targetUrl });
  }
  if (r.forwardsToUnidentifiedCode) {
    return finding("proxy", "unknown", FORWARDS_TO_UNIDENTIFIED_TITLE, FORWARDS_TO_UNIDENTIFIED_DETAIL, { evidenceUrl: url });
  }
  if (r.upgradeable) {
    // Naming the admin is the difference between "someone could" and "this account can".
    const words = UPGRADEABLE[r.slotKind ?? "eip1967"];
    const title = r.admin ? `Upgradeable — admin ${shortAddress(r.admin)}` : words.title;
    const detail = r.admin ? words.admin(r.admin) : words.noAdmin;
    return finding("proxy", "fail", title, detail, { evidenceUrl: url });
  }
  return finding("proxy", "pass", "Not a proxy", "No EIP-1967 or ZeppelinOS proxy slots are set and the code doesn't delegate calls.", { evidenceUrl: url });
}

/**
 * A top-holder list looks identical whether it is every holder or the first page of thousands, so
 * completeness has to come from the explorer: `page.complete` (it said there is no next page) or
 * `holdersCount`, its own count of every holder of this token (`holders_count`). "The top 3 of
 * 5,000 holders hold 24%" is not a concentration figure.
 */
export function checkHolders(
  input: InspectInput,
  page: HolderPage | null,
  totalSupply: bigint | null,
  scan: PoolScan | null,
  holdersCount: number | null,
): Finding {
  const url = `${input.explorerBase}/token/${input.address}?tab=holders`;
  if (page === null || !totalSupply) return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer didn't answer, or total supply is unknown.", { evidenceUrl: url });
  const holders = page.holders;
  // totalSupply > 0 (just checked above) guarantees at least one holder exists, so an empty list
  // here is never "0% concentration" — it's the explorer not having indexed this token yet. This
  // holds regardless of what the explorer's own holders-count field claims: a non-zero supply next
  // to a claimed holder count of 0 is itself a contradiction, not confirmation of "no holders".
  if (holders.length === 0) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer returned no holders for a token with non-zero supply, which usually means it hasn't indexed this token yet.", { evidenceUrl: url });
  }
  if (scan === null && input.dex) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The pool lookup failed, so a liquidity pool could be miscounted as a whale.", { evidenceUrl: url });
  }
  // Two ways the explorer can confirm the rows in hand are every holder there is: it sent
  // `next_page_params: null` (this page is the last one), or its own holder count is no bigger
  // than the number of rows it sent. Without one of them this is one page of a longer list.
  const listComplete = page.complete || (holdersCount !== null && holdersCount <= holders.length);
  // Fewer than ten rows is only a complete picture when the explorer positively says that's
  // everyone. Otherwise the share they add up to is a floor, not a measurement — a share computed
  // from an unknown fraction of the holders is never a pass.
  if (holders.length < 10 && !listComplete) {
    return finding("holders", "unknown", "Couldn't check holder concentration", `The explorer returned ${holders.length} holder(s) but doesn't confirm that's all of them, so this would only be part of the concentration.`, { evidenceUrl: url });
  }
  const knownPools = scan?.pools ?? [];
  // Uniswap v4 keeps the tokens of every pool in one contract, the PoolManager: it is a pool whether or not discovery found
  // a pool of this token there (a hooked pool nobody has listed yet holds tokens too), and never a wallet.
  const poolManager = input.dex?.v4 ? [lower(input.dex.v4.poolManager)] : [];
  const skip = new Set([lower(input.address), ...knownPools.map((p) => lower(p.address)), ...input.knownLockers.map(lower), ...poolManager]);
  const ranked = [...holders].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const top = ranked.filter((h) => !isBurn(h.address) && !skip.has(lower(h.address))).slice(0, 10);
  const held = top.reduce((sum, h) => sum + h.value, 0n);
  const pct = Number((held * 10000n) / totalSupply) / 100;
  const detail = "Excludes burn addresses, liquidity pools and known lock contracts.";
  // Excluding pools, burn addresses and the token itself can leave a full page with fewer than ten
  // wallets to add up. Calling those "all N wallets" is a claim about the whole holder list that
  // this page can't support, and the figure is a floor: more holders can only push it up. A floor
  // is still evidence for "at least this concentrated", so it can cross into warn or fail — it
  // just can never be the evidence for a pass.
  if (top.length < 10 && !listComplete) {
    const who = top.length === 1 ? "The top wallet holds" : `The top ${top.length} wallets hold`;
    const title = `${who} at least ${formatPct(pct)}`;
    if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
    if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
    return finding("holders", "unknown", "Couldn't check holder concentration", `Excluding pools, burn addresses and lock contracts left ${top.length} of the ${holders.length} rows the explorer sent, and it doesn't confirm those are all the holders — so ${formatPct(pct)} is a floor, not the concentration.`, { evidenceUrl: url });
  }
  // Say how many wallets the figure actually covers: "Top 10" on a token with three holders is a
  // claim about seven wallets that don't exist.
  const title =
    top.length >= 10 ? `Top 10 wallets hold ${formatPct(pct)}`
    : top.length === 0 ? "No wallet holds any of the supply"
    : top.length === 1 ? `The only wallet holds ${formatPct(pct)}`
    : `All ${top.length} wallets hold ${formatPct(pct)}`;
  if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
  if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
  return finding("holders", "pass", title, detail, { evidenceUrl: url });
}

const FACTORIES_SILENT =
  "Every call to the configured DEX contracts reverted, so no pool was found or ruled out — an address may hold no contract on this network.";

/** What was looked at, named from the config so that the finding is true of exactly the pools that were scanned. */
function noPoolFinding(dex: DexConfig): Finding {
  const uniswap = uniswapVersions(dex);
  const title = dex.aero
    ? `No ${uniswap.length > 0 ? "Uniswap or Aerodrome" : "Aerodrome"} pool found`
    : `No Uniswap ${listWith("or", uniswap)} pool found`;
  const venues = [...uniswap.map((v) => VENUE[v]), ...(dex.aero ? [VENUE.aero] : [])];
  const v4Caveat = dex.v4
    ? " Uniswap v4 pools are found by their standard hookless pool keys, so one with a hook or an unusual fee can be missed until an index lists it."
    : "";
  return finding("liquidity", "warn", title, `Looked at ${listWith("and", venues)} pools against ${listWith("and", dex.quoteTokens.map((q) => q.symbol))}.${v4Caveat}`);
}

/** What to say while a family of pool contracts never answered; null when every one did. */
const silentNote = (scan: PoolScan): string | null =>
  scan.silent.length > 0 ? `${listWith("and", scan.silent)} didn't answer, so a pool there can't be ruled out.` : null;

/** The kinds of pool a scan found, in the order v2, v3, v4, Aerodrome. */
const foundVersions = (pools: readonly Pool[]): PoolVersion[] => (["v2", "v3", "v4", "aero"] as const).filter((v) => pools.some((p) => p.version === v));
/** The same, by name. */
const foundVenues = (pools: readonly Pool[]): string[] => foundVersions(pools).map((v) => VENUE[v]);

/** The pool a finding is about: a liquid one, then an undecided one, then one that can't pay; the deepest within each. */
const rank = (p: Pool): number => (p.liquid === true ? 2 : p.liquid === null ? 1 : 0);
/** The pool the liquidity finding is about: a liquid one before an undecided one before one that can't pay, then the deepest. */
export const bestPool = (pools: Pool[]): Pool => pools.reduce((a, b) => (rank(a) !== rank(b) ? (rank(b) > rank(a) ? b : a) : b.depth > a.depth ? b : a));

const wholeUnits = (depth: bigint): string => (depth / 1_000_000n).toLocaleString("en-US");
/** "1,000": the amount the copy says a liquid pool can pay out, from the one constant that decides it. */
const MIN_UNITS = wholeUnits(MIN_DEPTH);

export function checkLiquidity(input: InspectInput, scan: PoolScan | null): Finding {
  const { dex } = input;
  if (!dex) return finding("liquidity", "unknown", "Liquidity isn't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("liquidity", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  if (!scan.factoriesAnswered) return finding("liquidity", "unknown", "Couldn't read liquidity pools", FACTORIES_SILENT);
  const pools = scan.pools;
  // A family that never answered can't be ruled out, so "no pool" and "thin" wait for it. A liquid pool found elsewhere doesn't.
  const silent = silentNote(scan);
  if (pools.length === 0) return silent ? finding("liquidity", "unknown", "Couldn't read liquidity pools", silent) : noPoolFinding(dex);
  const best = bestPool(pools);
  const units = wholeUnits(best.depth);
  const url = `${input.explorerBase}/address/${best.address}`;
  if (best.liquid === true) {
    return best.version === "v4"
      ? finding(
          "liquidity", "pass", `${MIN_UNITS} ${best.quote} can be swapped out of Uniswap v4`,
          `The v4 quoter can pay out ${MIN_UNITS} ${best.quote} from this pool. ${units} ${best.quote} in range at the current price; liquidity outside the current tick range isn't counted. ${pools.length} pool(s) found.`,
          { evidenceUrl: url },
        )
      : finding("liquidity", "pass", `${units} ${best.quote} of liquidity on ${VENUE[best.version]}`, `${pools.length} pool(s) found.`, { evidenceUrl: url });
  }
  // A quote that couldn't decide is no evidence of "thin", and with nothing liquid, none of "liquid" either.
  const undecided = pools.filter((p) => p.liquid === null);
  if (undecided.length > 0) {
    const why = [
      undecided.some((p) => p.undecided === "hook")
        ? `A Uniswap v4 pool has a hook, which can change what a swap pays, so a quote can't judge its liquidity.`
        : null,
      undecided.some((p) => p.undecided !== "hook") ? `The v4 quoter didn't answer for a Uniswap v4 pool, so it can't be called liquid or thin.` : null,
      silent,
    ].filter((x): x is string => x !== null);
    return finding("liquidity", "unknown", "Couldn't verify Uniswap v4 liquidity", why.join(" "), { evidenceUrl: `${input.explorerBase}/address/${undecided[0]!.address}` });
  }
  const deepest =
    best.version === "v4"
      ? `Deepest pool has ${units} ${best.quote} in range, and a ${MIN_UNITS} ${best.quote} swap can't be quoted.`
      : `Deepest pool holds ${units} ${best.quote}.`;
  return silent
    ? finding("liquidity", "unknown", "Couldn't read liquidity pools", `${silent} ${deepest}`, { evidenceUrl: url })
    : finding("liquidity", "warn", "Thin liquidity", deepest, { evidenceUrl: url });
}

/**
 * lp-lock. What the position index adds is warnings for Uniswap v4 liquidity, and nothing else:
 * - `lpLockWithoutIndex`, the check as it was before there was a position index, unchanged, has the last word on
 *   every pass, every fail and every unknown. The new path can't produce any of them;
 * - `lpLockByPath`, when a v4 pool is involved and the index is fresh, follows buyers' money in the order it would
 *   arrive and looks at who holds the quote currency already in the pools. When wallets hold or would take enough of
 *   it, it answers "warn". When they don't, when it can't read the whole picture, or when it fails in any way (its
 *   reads time out, a node refuses them, anything throws), it says nothing and the old check's answer is the finding.
 * A warning takes the place of the old check's pass or unknown, and gives way to its fail.
 * The old check's answer keeps its words too, but for the three unknowns that say positions "can't be read without an
 * index yet" (`Unread`). With an index that could be used (`IndexReading`), those say what Inspector read and what it
 * didn't instead (`unreadDetail`). Without one they stand word for word.
 * `token` is the inspected token's total supply and decimals, when known: the decimals are how a token count is written.
 */
export async function checkLpLock(input: InspectInput, scan: PoolScan | null, token: TokenFacts = { supply: null, decimals: null }): Promise<Finding> {
  if (!input.dex) return finding("lp-lock", "unknown", "Locks aren't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("lp-lock", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  if (!input.v4Positions || !input.dex.v4) return (await lpLockWithoutIndex(input, scan)).finding;
  // The old check starts first and runs beside the new path, with all the time it had before there was one.
  const before = lpLockWithoutIndex(input, scan);
  before.catch(() => undefined);
  let found: Finding | null = null;
  let reading: IndexReading;
  try {
    const tally = await tallyOrWhyNot(input, scan, input.dex);
    if (typeof tally === "string") reading = { kind: tally === "unusable" ? "none" : "uninvolved" };
    else {
      found = lpLockByPath(scan, input.dex, tally, token);
      reading = tally.blockers.length > 0 ? { kind: "blocked", reasons: tally.blockers } : { kind: "read", unclassified: tally.unclassifiedHolders };
    }
  } catch (e) {
    // Whatever stopped the new path (the inspection's deadline, a node refusing the index's tail, anything else), it
    // has nothing to add, and takes nothing away: the old check answers, and its words say what stopped the reading.
    reading = { kind: "stopped", timedOut: e instanceof ReadsTimedOut };
  }
  const old = await before;
  if (found !== null && old.finding.status !== "fail") return found;
  return old.unread === null || reading.kind === "none" ? old.finding : { ...old.finding, detail: unreadDetail(old.unread, reading, input, scan) };
}

/**
 * What the position index came to in an inspection that was given one, for the words of an answer the old check gives.
 * - `none`: it couldn't be used. It is more than `TAIL_MAX_BLOCKS` behind the head, so the inspection is one without an
 *   index, and the old words stand;
 * - `uninvolved`: it was read, and no v4 pool is involved (none found, none created since its cursor, no list cut short);
 * - `read`: every v4 position was read and its holder classified, and nothing reached a warning. `unclassified`: the
 *   holders whose code wasn't read (`MAX_HOLDER_CODE_READS`);
 * - `blocked`: the reading had to stop short of the whole picture, for `reasons` (the tally's blockers);
 * - `stopped`: something cut the reading off: the inspection's deadline (`timedOut`) or an error. This may be before
 *   the index's cursor was checked against the head. An index that was given and not known to be stale is not taken
 *   for no index.
 */
type IndexReading =
  | { kind: "none" }
  | { kind: "uninvolved" }
  | { kind: "read"; unclassified: number }
  | { kind: "blocked"; reasons: readonly string[] }
  | { kind: "stopped"; timedOut: boolean };

/**
 * The words for an unknown of the old check that rests on positions it can't read (`Unread`), when the inspection had an
 * index. They replace "can't be read without an index yet" with what was read and what wasn't:
 * - the old check's own finding, the same as before. Uniswap v3 and Aerodrome positions are read by nothing, index or
 *   not, and that is said without tying it to an index;
 * - what came of the Uniswap v4 reading (`IndexReading`). "Nothing to warn about" says only that what it counted
 *   stayed under the warning's lines, and why that is never a pass: a lock in a v4 pool can't be confirmed.
 */
function unreadDetail(unread: Unread, reading: Exclude<IndexReading, { kind: "none" }>, input: InspectInput, scan: PoolScan): string {
  const names = (versions: readonly PoolVersion[]) => listWith("and", versions.map((v) => VENUE[v]));
  let found: string;
  if (unread.kind === "only") {
    const unreadable = unread.versions.filter((v) => v !== "v4");
    found =
      unreadable.length === 0
        ? `Only ${names(unread.versions)} pools were found.`
        : unreadable.length === unread.versions.length
          ? `Only ${names(unread.versions)} pools were found, and Inspector doesn't read the positions in them.`
          : `Only ${names(unread.versions)} pools were found, and Inspector doesn't read the positions in the ${names(unreadable)} ones.`;
  } else if (unread.kind === "rival") {
    found = `The deepest pool is ${unread.version === "aero" ? "an" : "a"} ${VENUE[unread.version]} pool, and Inspector doesn't read the positions in it.`;
  } else {
    found = "A Uniswap v4 pool that may hold more than this v2 pair sits beside it.";
  }
  const v4 = (() => {
    switch (reading.kind) {
      case "uninvolved":
        return [];
      case "read": {
        const n = reading.unclassified;
        return [
          "Inspector read who holds the Uniswap v4 positions.",
          "In the pools Inspector can read, positions wallets can withdraw are under the thresholds for a warning, in what they hold now and in what the next buyers would pay into them.",
          ...(n > 0
            ? [`${n === 1 ? "1 holder of this token's liquidity wasn't" : `${n.toLocaleString("en-US")} holders of this token's liquidity weren't`} classified, more than this check reads, and what ${n === 1 ? "it holds" : "they hold"} isn't counted as a wallet's.`]
            : []),
          "That isn't a pass: Inspector can't confirm a lock in a Uniswap v4 pool.",
          input.knownLockers.length === 0
            ? "It recognizes no lock contracts yet, and it counts a position held by a contract as neither locked nor withdrawable."
            : "It counts a position held by a contract other than a lock contract it recognizes as neither locked nor withdrawable.",
        ];
      }
      case "blocked":
        return ["Inspector read the position index, but couldn't tell who holds all the liquidity in this token's pools.", ...reading.reasons];
      case "stopped":
        // Said only where a v4 pool is known to be involved: with none found and no list cut short, none is known unread.
        if (!scan.pools.some((p) => p.version === "v4") && !poolListCutShort(input, scan)) return [];
        return [reading.timedOut ? "Inspector ran out of time before it had read who holds the Uniswap v4 positions." : "Inspector couldn't finish reading who holds the Uniswap v4 positions."];
    }
  })();
  return [found, ...v4].join(" ");
}

/** The token's total supply (raw units) and decimals, null when they couldn't be read. */
export type TokenFacts = { supply: bigint | null; decimals: number | null };

/**
 * What `tallyLiquidity` found, for the verdict. Quote amounts are 6-decimal units times `SHARE_SCALE`; token amounts raw.
 * - `bids`: the quote currency the positions hold now, by class (`HolderClass`), over every pool found;
 * - `path`: where buyers' money would go (`AskPath`), one path over every pool found. Null when nothing is for sale;
 * - `unclassifiedHolders`: how many holders' code wasn't read;
 * - `blockers`: the reasons the picture itself isn't complete, each a sentence. With any, the new path says nothing,
 *   and an unknown of the old check that would say there is no index names them instead (`unreadDetail`);
 * - the two links: the largest position (or v2 holder list, or pool) of each kind.
 */
export type LiquidityTally = {
  bids: ClassSums;
  path: AskPath | null;
  unclassifiedHolders: number;
  blockers: string[];
  openUrl: string | null;
  safeUrl: string | null;
};

/**
 * Amounts are kept in the quote currency's 6-decimal units times this, so that splitting a v2 pair's reserve by its LP
 * holders loses nothing that could move a share across a line.
 */
export const SHARE_SCALE = 10n ** 12n;

const GAP_REASON: Record<PoolGap, string> = {
  missing: "The position index has no entry yet for a Uniswap v4 pool of this token.",
  truncated: `A Uniswap v4 pool of this token has more than ${MAX_POSITIONS_PER_POOL} positions, more than this check reads.`,
  // Not shown: an index this far behind sends the whole check to `lpLockWithoutIndex` (see `tallyLiquidity`).
  stale: `The position index is more than ${TAIL_MAX_BLOCKS.toLocaleString("en-US")} blocks behind the chain.`,
  mismatch: "The position index has a gap: the positions it lists for a Uniswap v4 pool don't add up to the pool's liquidity.",
  unreadable: "The positions of a Uniswap v4 pool couldn't be read.",
};

/**
 * Uniswap v4 reads a hook's permissions off its address (v4-core `src/libraries/Hooks.sol`). These four let it run in a
 * swap: BEFORE_SWAP (1 << 7) and AFTER_SWAP (1 << 6) can refuse one, and their RETURNS_DELTA flags (1 << 3, 1 << 2) can
 * take part of what it pays. In such a pool "buyers pay this position" is the hook's to decide.
 */
const SWAP_FLAGS = (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
const hookRunsInSwaps = (key: PoolKey): boolean => (BigInt(key.hooks) & SWAP_FLAGS) !== 0n;
/** A v4 pool key's fee field with this value means the fee is the hook's to set, swap by swap (v4-core `LPFeeLibrary`). */
const DYNAMIC_FEE_FLAG = 0x800000;
/** The highest LP fee of a plain pool, in pips: 1%, the top standard tier. Above it no router sends a buyer. */
const MAX_PLAIN_FEE = 10_000;

/**
 * Everything lp-lock's new path reads, over every pool the scan found, in the quote currency.
 *
 * Who holds what:
 * - a Uniswap v2 pair, by LP-token balance: burn addresses, the chain's known lockers, and the rest, which is
 *   withdrawable where the chain's lock contracts are vetted (`lockersVetted`) and "unvetted" where they aren't;
 * - a Uniswap v4 position, read live, by its holder (`classifyHolder`): burned, locked, a wallet's (withdrawable, or
 *   "hook" when the pool's hook runs on removal and so can block or tax it), a contract's (it may be a locker, and its
 *   terms aren't read), or unclassified (past the `MAX_HOLDER_CODE_READS` largest holders);
 * - a Uniswap v3 or Aerodrome pool: "venue" as a whole, its positions can't be read. Its quote counts in the bids;
 *   what it sells is on no path.
 * In a pool that isn't plain (a hook that runs in swaps, a dynamic fee or one above 1%, a quote that isn't USDC) a
 * wallet's slice is "elsewhere" and a burned or locked one "doubted": see `HolderClass`.
 *
 * What is measured (`LiquidityTally`):
 * - `bids`: the quote currency each class holds now, in every pool. EURC counts 1:1 with USDC;
 * - `path`: the asks, every position's token side above its pool's price, as one path over every pool, ordered by
 *   what a buyer pays per token, the pool's LP fee included (lp-path.ts). A v2 pair charges 0.3%; a v4 pool its
 *   `lpFee` as slot0 has it now, which for a dynamic-fee pool is the fee of the moment. EURC counts 1:1 with USDC,
 *   which misplaces an EURC pool's asks by what EURC trades away from a dollar.
 *
 * Answers null when the new path has nothing to read: the index is more than `TAIL_MAX_BLOCKS` behind the head, or no
 * v4 pool is involved (see `checkLpLock`). Rejects with `ReadsTimedOut` when the inspection's deadline passes first.
 */
export async function tallyLiquidity(input: InspectInput, scan: PoolScan, dex: DexConfig): Promise<LiquidityTally | null> {
  const tally = await tallyOrWhyNot(input, scan, dex);
  return typeof tally === "string" ? null : tally;
}

/** A pool list that was cut short may hide a v4 pool, so it counts as one being involved. */
const poolListCutShort = (input: InspectInput, scan: PoolScan): boolean => input.extraPoolsTruncated === true || scan.truncated === true;

/**
 * `tallyLiquidity`, saying why there is no tally: `unusable` when there is no index to read or it is more than
 * `TAIL_MAX_BLOCKS` behind the head, `uninvolved` when it was read and no v4 pool is involved.
 */
async function tallyOrWhyNot(input: InspectInput, scan: PoolScan, dex: DexConfig): Promise<LiquidityTally | "unusable" | "uninvolved"> {
  const dollar = (symbol: string | undefined) => symbol === "USDC";
  const { reader, explorerBase } = input;
  if (!dex.v4 || !input.v4Positions) return "unusable";
  // A second kept for the rest of the report, as the trade check keeps one.
  const deadlineAt = input.deadlineAt === undefined ? undefined : input.deadlineAt - 1_000;
  // The index first, before anything is counted: whether it is fresh decides whether this path answers at all.
  const quotes = v4Quotes(input, dex);
  let unmapped = false;
  const quoteOf = new Map<string, string>();
  const refs = scan.pools.flatMap((p): V4PoolRef[] => {
    if (p.version !== "v4") return [];
    const { key, poolId } = p;
    const quoteIsCurrency0 = key !== undefined && lower(key.currency1) === lower(input.address);
    const quote = key && quotes.find((q) => lower(q.address) === lower(quoteIsCurrency0 ? key.currency0 : key.currency1));
    if (key && poolId && quote) {
      quoteOf.set(lower(poolId), quote.symbol);
      return [{ poolId, key, quoteIsCurrency0, quoteDecimals: quote.decimals }];
    }
    unmapped = true;
    return [];
  });
  // Asked even with no v4 pool to read: the index's tail also says whether the token gained a v4 pool the lookup missed.
  const v4Read = await readV4Positions({ reader, v4: dex.v4, pools: refs, index: input.v4Positions, token: input.address, quotes: quotes.map((q) => q.address), deadlineAt });
  if (v4Read.stale) return "unusable";
  const listTruncated = poolListCutShort(input, scan);
  const v4Involved = unmapped || listTruncated || v4Read.unlisted.length > 0 || scan.pools.some((p) => p.version === "v4");
  if (!v4Involved) return "uninvolved";

  // What keeps the picture itself from being complete. Any one of them makes the answer unknown.
  const blockers = new Set<string>();
  const silent = silentNote(scan);
  if (silent) blockers.add(silent);
  if (listTruncated) blockers.add(`This token has more Uniswap v4 pools than are read (over ${MAX_EXTRA_POOLS}), so its liquidity can't be added up.`);
  if (unmapped) blockers.add(GAP_REASON.unreadable);
  if (v4Read.unlisted.length > 0) blockers.add("A Uniswap v4 pool of this token was created in the last minutes and isn't in the index yet, so its liquidity isn't counted.");

  const bids = noSums();
  const asks: Ask[] = [];
  /** A holder's class in a pool that isn't plain: a wallet's is "elsewhere", burned or locked is "doubted". */
  const classIn = (isPlain: boolean, owner: HolderClass): HolderClass => (isPlain ? owner : owner === "withdrawable" ? "elsewhere" : owner === "burned" || owner === "locked" ? "doubted" : owner);
  // The largest slice of each kind, for the evidence link: by the quote it holds now and what it would take.
  let largestOpen: { amount: bigint; url: string } | null = null;
  let largestSafe: { amount: bigint; url: string } | null = null;
  const note = (owner: HolderClass, amount: bigint, url: string) => {
    if (amount <= 0n) return;
    if (owner === "burned" || owner === "locked" || owner === "doubted") {
      if (!largestSafe || amount > largestSafe.amount) largestSafe = { amount, url };
    } else if (!largestOpen || amount > largestOpen.amount) largestOpen = { amount, url };
  };

  // Uniswap v2: the pair, split by who holds the LP token.
  for (const pair of scan.pools) {
    if (pair.version !== "v2") continue;
    const read = (fn: string, args: unknown[] = []) => beforeDeadline(deadlineAt, () => reader.read(pair.address, erc20Abi, fn, args) as Promise<bigint>);
    const supply = await read("totalSupply");
    if (supply === 0n) {
      // No evidence to compute a locked share from: an LP token with 0 supply isn't a "fail".
      blockers.add("The v2 LP token's totalSupply is 0.");
      continue;
    }
    const [burnt, inLockers] = await Promise.all(
      [BURN_ADDRESSES, input.knownLockers].map(async (holders) => (await Promise.all(holders.map((a) => catchReverted(read("balanceOf", [a]), 0n)))).reduce((s, b) => s + b, 0n)),
    );
    const kept = burnt! + inLockers! > supply ? supply : burnt! + inLockers!;
    const share = (amount: bigint) => {
      const safe = (amount * kept) / supply;
      const burned = kept === 0n ? 0n : (safe * burnt!) / (burnt! + inLockers!);
      return { burned, locked: safe - burned, rest: amount - safe };
    };
    const [quote, tokens] = [share(pair.depth * SHARE_SCALE), share(pair.tokenReserve ?? 0n)];
    const price = v2TokenSqrtPrice(pair.depth, pair.tokenReserve ?? 0n);
    const url = `${explorerBase}/token/${pair.address}?tab=holders`;
    // "Withdrawable" says nothing holds it but wallets, so it needs the chain's lock contracts to be known (`lockersVetted`,
    // true on Arc). Where they aren't, LP that isn't burned may still sit in one.
    for (const [owner, part] of [["burned", "burned"], ["locked", "locked"], [input.lockersVetted ? "withdrawable" : "unvetted", "rest"]] as const) {
      // A v2 pair is plain when its quote is a dollar.
      const as = classIn(dollar(pair.quote), owner);
      bids[as] += quote[part];
      const ask = v2Ask({ owner: as, price, reserve: quote[part], tokens: tokens[part] });
      if (ask) asks.push(ask);
      note(owner, quote[part], url);
    }
  }

  // Uniswap v3 and Aerodrome: positions are NFTs nothing here reads. The pool's quote is nobody's in particular, and
  // what it sells is on no path.
  for (const p of scan.pools) {
    if (p.version !== "v3" && p.version !== "aero") continue;
    bids.venue += p.depth * SHARE_SCALE;
    note("venue", p.depth * SHARE_SCALE, `${explorerBase}/address/${p.address}`);
  }

  // Uniswap v4: the positions, each by its holder.
  const { positionManager } = dex.v4;
  const pools = v4Read.pools.flatMap((r) => {
    if (r.gap !== null) {
      blockers.add(GAP_REASON[r.gap]);
      return [];
    }
    return [r];
  });
  // Ranked for the code reads by the quote each holds now and its liquidity: a holder past the cap stays unclassified.
  const { code, unread: unclassifiedHolders } = await readHolderCode(
    reader,
    pools.flatMap((r) => r.positions.map((p) => ({ holder: p.holder, value: p.quote * 2n ** 128n + p.liquidity }))),
    input.knownLockers,
    deadlineAt,
  );
  for (const r of pools) {
    const removalHook = hookCanChangeRemoval(r.pool.key);
    // Plain: nothing but the liquidity math stands between a buyer and the position, at a fee a router would pay, in dollars.
    const isPlain = !hookRunsInSwaps(r.pool.key) && r.pool.key.fee !== DYNAMIC_FEE_FLAG && r.lpFee <= MAX_PLAIN_FEE && dollar(quoteOf.get(lower(r.pool.poolId)));
    for (const position of r.positions) {
      const holder = lower(position.holder);
      const who = classifyHolder(position.holder, { knownLockers: input.knownLockers, code: code.has(holder) ? code.get(holder)! : undefined });
      const owner = classIn(isPlain, who === "wallet" ? (removalHook ? "hook" : "withdrawable") : who);
      const url = position.tokenId === null ? `${explorerBase}/address/${position.holder}` : `${explorerBase}/token/${positionManager}/instance/${position.tokenId}`;
      const ask = v4Ask({
        owner,
        sqrtPriceX96: r.sqrtPriceX96,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
        quoteIsCurrency0: r.pool.quoteIsCurrency0,
        quoteDecimals: r.pool.quoteDecimals,
        feePips: r.lpFee,
        scale: SHARE_SCALE,
      });
      bids[owner] += position.quote * SHARE_SCALE;
      if (ask) asks.push(ask);
      // A position that only sells tokens holds no quote yet: one unit, so that it can still be the one linked.
      note(owner, position.quote * SHARE_SCALE + (ask ? 1n : 0n), url);
    }
  }

  return {
    bids,
    path: findPath(asks, MIN_DEPTH * SHARE_SCALE),
    unclassifiedHolders,
    blockers: [...blockers],
    openUrl: (largestOpen as { url: string } | null)?.url ?? null,
    safeUrl: (largestSafe as { url: string } | null)?.url ?? null,
  };
}

/**
 * A raw token amount as a finding says it: "5.2M tokens", cut to one decimal, or "tokens" when the token's decimals aren't
 * known. Never the token's symbol: the deployer chose it, and it has no place in a sentence about what a wallet holds.
 */
function tokenAmount(raw: bigint, decimals: number | null): string {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return "tokens";
  const whole = raw / 10n ** BigInt(decimals);
  if (whole < 1_000n) return `${whole} tokens`;
  const steps: [bigint, string][] = [[10n ** 12n, "T"], [10n ** 9n, "B"], [10n ** 6n, "M"], [10n ** 3n, "K"]];
  const [unit, letter] = steps.find(([size]) => whole >= size)!;
  const tenths = (whole * 10n) / unit;
  // Past the trillions the figure is written out: "1,234T" would be harder to read than the number.
  if (letter === "T" && tenths >= 10_000n) return `${whole.toLocaleString("en-US")} tokens`;
  return `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}${letter} tokens`;
}

/**
 * The new path's verdict over `tallyLiquidity`: a warning, or null (nothing to add: the old check answers). It never
 * fails a token and never passes one.
 * On the path, a "prefix" is the quote buyers have paid in from the cheapest ask of any pool up to some price; the
 * window is every prefix from P1, where 1,000 units have been paid (`MIN_DEPTH`), to twice that price, or the whole
 * path as one prefix when it never takes 1,000. Every class counts in a prefix's total. P is the share of wallets in
 * plain pools ("withdrawable"), W that plus wallets in the other pools ("elsewhere").
 * The warning has one of two titles, each a plain statement of what was read:
 * - "Wallets hold most of the USDC Inspector found in its pools": wallets in plain pools hold at least 1,000 units
 *   of the bids, and more than half of all of them. Money, which is there whatever the token's market is;
 * - "Some liquidity isn't locked": P > 5% in some prefix (a majority too: the detail gives the share, and tokens for
 *   sale alone carry no stronger title), or of the bids once the pools hold 1,000 units; or W >= 50%
 *   there with wallets outside plain pools among them (alone they warn only from half: what they show costs nothing
 *   and may be out of anyone's reach); or the tokens wallets sell beyond the window are a tenth or more of all the
 *   tokens for sale on the path.
 * Why no fail: every way of proving that the money buyers pay is a rug-puller's to take has had a hole. Tokens are
 * free and a pool's price is its creator's choice; quote parked under a price nobody sells at is at no risk; a
 * stranger's listing can stand beside another holder's money. A fail from positions would need the bids bounded by
 * the tokens that could actually be sold into them, money matched to asks holder by holder, or the deployer's
 * identity. Until then the reading says what wallets hold and would be paid, in the pools read here, and no more.
 * Any blocker: null.
 */
function lpLockByPath(scan: PoolScan, dex: DexConfig, tally: LiquidityTally, token: TokenFacts): Finding | null {
  if (tally.blockers.length > 0) return null;
  const { bids, path } = tally;
  // The quote currencies of the pools found, in the config's order (USDC before EURC).
  const found = new Set(scan.pools.map((p) => p.quote));
  const symbol = [...new Set([...dex.quoteTokens.map((q) => q.symbol).filter((q) => found.has(q)), ...found])].join("/");
  const sum = (m: ClassSums) => HOLDER_CLASSES.reduce((s, owner) => s + m[owner], 0n);
  const safe = (m: ClassSums) => m.burned + m.locked;
  const wallets = (m: ClassSums) => m.withdrawable + m.elsewhere;
  const pct = (part: bigint, of: bigint) => formatPct(of === 0n ? 0 : Number((part * 10_000n) / of) / 100);
  const units = (scaled: bigint) => wholeUnits(scaled / SHARE_SCALE);
  // What buyers pay up to a point on the path, to the nearest unit: the point is found to the unit, not below it.
  const paid = (scaled: bigint) => wholeUnits(((scaled / SHARE_SCALE + 500_000n) / 1_000_000n) * 1_000_000n);
  // Shares are compared with a millionth of slack: amounts are rounded down position by position, and a share that is
  // exactly on a line must not fall on either side of it by that dust.
  const DUST = 1_000_000n;
  const atLeast = (part: bigint, of: bigint, percent: bigint) => part * 100n + of / DUST >= of * percent;
  const above = (part: bigint, of: bigint, percent: bigint) => part * 100n > of * percent + of / DUST;
  /** The view where `of` is the largest share; the first of equals, which says it best. */
  const most = (of: (m: ClassSums) => bigint, among: ClassSums[]) => among.reduce((a, b) => (of(b) * sum(a) > of(a) * sum(b) + (sum(a) * sum(b)) / DUST ? b : a));
  const THOUSAND = MIN_DEPTH * SHARE_SCALE;

  // --- Asks.
  const views = (path?.prefixes ?? []).filter((p) => sum(p) > 0n);
  const plainWarn = views.some((m) => above(m.withdrawable, sum(m), 5n));
  const anyWarn = plainWarn || views.some((m) => m.elsewhere > 0n && atLeast(wallets(m), sum(m), 50n));
  // Tokens wallets still sell beyond the window: counted, never priced, and set against every token for sale on the path.
  const beyond = path?.beyond ?? noSums();
  const forSale = path === null ? 0n : path.windowTokens + sum(path.beyond);
  const beyondPlain = beyond.withdrawable > 0n && beyond.withdrawable * 10n >= forSale;
  const beyondAny = wallets(beyond) > 0n && wallets(beyond) * 10n >= forSale;

  // --- Bids.
  const bidTotal = sum(bids);
  const bidsMaterial = bidTotal >= THOUSAND;
  // "Most" is more than half.
  const mostOfBids = bids.withdrawable >= THOUSAND && above(bids.withdrawable, bidTotal, 50n);
  const bidsPlainWarn = bidsMaterial && above(bids.withdrawable, bidTotal, 5n);
  const bidsAnyWarn = bidsPlainWarn || (bidsMaterial && bids.elsewhere > 0n && atLeast(wallets(bids), bidTotal, 50n));

  if (!anyWarn && !beyondAny && !bidsAnyWarn) return null;

  // --- The words. All wallets are quoted, and "would ... if" is said where the share rests on wallets outside plain pools.
  const asksConditional = !plainWarn && anyWarn;
  const beyondConditional = !beyondPlain && beyondAny;
  const of = plainWarn || !anyWarn ? (m: ClassSums) => m.withdrawable : wallets;
  const worst = views.length > 0 ? most(of, views) : null;
  const beyondTokens = beyondAny ? (beyondConditional ? wallets(beyond) : beyond.withdrawable) : 0n;
  const HOOKED = "behind a swap hook, a dynamic or high fee, or in a pool not quoted in USDC";
  /** Burned or locked liquidity outside plain pools is said apart, never folded into either side. */
  const lockedShares = (m: ClassSums) =>
    m.doubted > 0n
      ? `, ${pct(safe(m), sum(m))} into burned or locked ones and ${pct(m.doubted, sum(m))} into burned or locked ones ${HOOKED}`
      : ` and ${pct(safe(m), sum(m))} into burned or locked ones`;
  // Holders whose code wasn't read could be wallets too: said when, with them, wallets would reach half.
  const couldBeHalf = !mostOfBids && [...views, ...(bidsMaterial ? [bids] : [])].some((m) => m.unclassified > 0n && atLeast(wallets(m) + m.unclassified, sum(m), 50n));
  // The path is described only when wallets take something on it, or sell beyond its window: a finding shows the lines
  // that carry it.
  const onPath = worst !== null && (of(worst) > 0n || beyondTokens > 0n);
  const windowed = path?.reached === true;
  const first = worst === null ? "" : windowed ? `of the first ${paid(sum(worst))} ${symbol} buyers would pay for this token` : `of the ${paid(sum(worst))} ${symbol} buyers could pay for the tokens now for sale`;
  const lines = [
    worst &&
      onPath &&
      (asksConditional
        ? `${first}, ${pct(of(worst), sum(worst))} would go into positions wallets can withdraw${lockedShares(worst)}, if the hooks and fees of the pools selling it let buyers through.`
        : `${first}, ${pct(of(worst), sum(worst))} goes into positions wallets can withdraw${lockedShares(worst)}.`),
    bidTotal > 0n &&
      `of the ${units(bidTotal)} ${symbol} in its pools now, wallets' positions hold ${units(wallets(bids))}${bids.elsewhere > 0n ? ` (${units(bids.elsewhere)} of it ${HOOKED}, where nobody may be able to sell into it)` : ""}${bids.doubted > 0n ? `, burned or locked ones ${units(safe(bids))} and burned or locked ones ${HOOKED} ${units(bids.doubted)}` : ` and burned or locked ones ${units(safe(bids))}`}.`,
    beyondTokens > 0n &&
      `wallets also hold ${tokenAmount(beyondTokens, token.decimals)} in positions above twice that price${beyondConditional ? `, ${HOOKED}` : ""}, which buyers would pay into if the price rises that far.`,
    couldBeHalf && `${tally.unclassifiedHolders.toLocaleString("en-US")} holders of this token's liquidity weren't classified, more than this check reads: with them, wallets could hold half or more.`,
    onPath &&
      (windowed
        ? `counted in the order buyers' money would arrive, by what a buyer pays per token in each pool, fee included, up to twice the price at which ${MIN_UNITS} ${symbol} has been paid.`
        : `counted in the order buyers' money would arrive, by what a buyer pays per token in each pool, fee included; the tokens for sale would take under ${MIN_UNITS} ${symbol} in all.`),
  ].filter((x): x is string => typeof x === "string");
  // The reading is about the pools read here, and says so where it starts.
  const sentence = (line: string) => `${line[0]!.toUpperCase()}${line.slice(1)}`;
  const detail = `In the pools Inspector can read, ${[lines[0]!, ...lines.slice(1).map(sentence)].join(" ")}`;
  // The strong title rests on money in the pools, never on tokens for sale: those are free, and say where buyers'
  // money goes only when the token's market is on the pools read.
  const title = mostOfBids ? `Wallets hold most of the ${symbol} Inspector found in its pools` : "Some liquidity isn't locked";
  return finding("lp-lock", "warn", title, detail, { evidenceUrl: tally.openUrl, fixAppId: "vault" });
}

/**
 * Which positions an unknown of the old check rests on, when it is one that says they "can't be read without an index
 * yet". `checkLpLock` words it anew for an inspection that had an index (`unreadDetail`).
 * - `only`: only pools other than Uniswap v2 were found (`versions`, in the order v3, v4, Aerodrome);
 * - `rival`: a deeper Uniswap v3 or Aerodrome pool sits beside a pair whose LP is burned or locked;
 * - `v4-rival`: a Uniswap v4 pool that may hold more sits beside such a pair.
 */
type Unread = { kind: "only"; versions: PoolVersion[] } | { kind: "rival"; version: PoolVersion } | { kind: "v4-rival" };

/**
 * lp-lock without the position index: only Uniswap v2 has LP tokens to count, and a pool of another kind that may hold
 * more than the pair keeps a burned pair from passing. This is the check as it stood before the index, kept for the
 * inspections that have none (testnet, a browser that couldn't fetch it) and for a token with no v2 or v4 pool. Its
 * finding is word for word what it always said; `unread` says which positions an unknown rests on (`Unread`), null for
 * every other answer.
 */
async function lpLockWithoutIndex(input: InspectInput, scan: PoolScan): Promise<{ finding: Finding; unread: Unread | null }> {
  const v2 = scan.pools.filter((p) => p.version === "v2");
  if (v2.length === 0) {
    // Only v2 has LP tokens to count. Positions in v3, v4 and Aerodrome pools are NFTs or entries in the PoolManager, and
    // reading who holds them needs an index.
    const why = !scan.factoriesAnswered
      ? FACTORIES_SILENT
      : scan.pools.length === 0
        ? (silentNote(scan) ?? "No pool was found.")
        : `Only ${listWith("and", foundVenues(scan.pools))} pools were found, and liquidity positions in them can't be read without an index yet.`;
    const unread: Unread | null = scan.factoriesAnswered && scan.pools.length > 0 ? { kind: "only", versions: foundVersions(scan.pools) } : null;
    // A "fix" button doesn't belong on something we couldn't check.
    return { finding: finding("lp-lock", "unknown", "Couldn't check liquidity locks", why, { fixAppId: null }), unread };
  }
  const pair = v2.reduce((a, b) => (b.depth > a.depth ? b : a));
  // A pool whose positions can't be read might hold more than the pair. A v3 or Aerodrome pool is one when it is deeper; a v4
  // pool's figure is only what sits in its current range, so it can't be ranked. It is no rival only when it decisively can't
  // pay 1,000 units and the pair can: a pair that can't pay them either may still be the shallower of the two.
  const others = scan.pools.filter((p) => p.version !== "v2" && p.version !== "v4" && p.depth > pair.depth);
  const rival = others.length > 0 ? others.reduce((a, b) => (b.depth > a.depth ? b : a)) : null;
  const v4Rival = scan.pools.some((p) => p.version === "v4" && (p.liquid !== false || pair.depth < MIN_DEPTH));
  const read = (fn: string, args: unknown[] = []) => input.reader.read(pair.address, erc20Abi, fn, args) as Promise<bigint>;
  const supply = await read("totalSupply");
  const url = `${input.explorerBase}/token/${pair.address}?tab=holders`;
  if (supply === 0n) {
    // No evidence to compute a locked share from — an LP token with 0 supply isn't a "fail".
    return { finding: finding("lp-lock", "unknown", "Couldn't check liquidity locks", "The v2 LP token's totalSupply is 0.", { fixAppId: null }), unread: null };
  }
  const safe = [...BURN_ADDRESSES, ...input.knownLockers];
  const balances = await Promise.all(safe.map((a) => catchReverted(read("balanceOf", [a]), 0n)));
  const locked = balances.reduce((s, b) => s + b, 0n);
  const pct = Number((locked * 10000n) / supply) / 100;
  if (pct >= 95 && (rival || v4Rival)) {
    const detail = rival
      ? `The deepest pool is ${rival.version === "aero" ? "an" : "a"} ${VENUE[rival.version]} position, which can't be read without an index yet.`
      : "A Uniswap v4 pool that may hold more than this v2 pair sits beside it, and positions in it can't be read without an index yet.";
    const unread: Unread = rival ? { kind: "rival", version: rival.version } : { kind: "v4-rival" };
    return { finding: finding("lp-lock", "unknown", "Couldn't check liquidity locks", detail, { fixAppId: null }), unread };
  }
  // "Isn't locked" says nothing holds it but wallets, so it needs the chain's lock contracts to be known (`lockersVetted`,
  // true on Arc). Where they aren't, LP that isn't burned may still sit in one.
  if (pct < 95 && !input.lockersVetted) {
    return {
      finding: finding(
        "lp-lock", "unknown", "Couldn't check liquidity locks",
        `${formatPct(100 - pct)} of the v2 LP supply isn't burned or in a known lock contract, and the lock contracts on ${input.chain.name} aren't recognized yet, so whether it can be withdrawn can't be told.`,
        { evidenceUrl: url, fixAppId: null },
      ),
      unread: null,
    };
  }
  return {
    finding: pct >= 95
      ? finding("lp-lock", "pass", "Liquidity is burned or locked", `${formatPct(pct)} of the v2 LP supply can't be withdrawn.`, { evidenceUrl: url })
      : finding("lp-lock", "fail", "Liquidity isn't locked", `${formatPct(100 - pct)} of the v2 LP supply sits in wallets that can withdraw it.`, { evidenceUrl: url, fixAppId: "vault" }),
    unread: null,
  };
}

export function checkPrevrandao(input: InspectInput, logicCode: string | null, gap: LogicGap | null): Finding {
  if (logicCode === null) {
    const { title, detail } = LOGIC_GAP[gap ?? "logic-unreadable"];
    return finding("prevrandao", "unknown", title, detail);
  }
  // What PREVRANDAO gives is the chain's: on Arc it is always 0 (`InspectChain.prevrandao`).
  const { warnTitle, detail, evidenceUrl } = input.prevrandao;
  return usesOpcode(logicCode, 0x44)
    ? finding("prevrandao", "warn", warnTitle, detail, { evidenceUrl })
    : finding("prevrandao", "pass", "Doesn't rely on on-chain randomness", "The PREVRANDAO opcode isn't used.");
}

/** A loss up to the pool's fees plus this much is the pool's doing, not the token's (ppm). */
const TRADE_SLACK = 30_000n;
/** The line for a pool whose fee can change from one swap to the next: a 5% loss (ppm). */
const TRADE_LINE_VARIABLE_FEE = 50_000n;

/** A USDC amount in 6 decimals: to at most 4 decimal places from 1 USDC up ("9.94"), all 6 below it ("0.009998"). Cut, not rounded. */
function usdcAmount(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  const shown = (whole === 0n ? fraction : fraction.slice(0, 4)).replace(/0+$/, "");
  return shown ? `${whole.toLocaleString("en-US")}.${shown}` : whole.toLocaleString("en-US");
}

/** Parts per million as a percentage with at most one decimal, rounded half up: 103_000 is "10.3%", 1_000_000 is "100%",
 * 400 is "under 0.1%". */
const ppmPct = (ppm: bigint): string => {
  const tenths = (ppm + 500n) / 1000n;
  if (tenths === 0n && ppm > 0n) return "under 0.1%";
  return tenths % 10n === 0n ? `${tenths / 10n}%` : `${tenths / 10n}.${tenths % 10n}%`;
};

const TRADE_UNKNOWN = "Couldn't simulate a trade";
const SIMULATED = "Simulated in one eth_call against the pool itself; nothing was sent.";
const SOLD_BACK_REVERTED = "selling straight back, in the same transaction and from a contract, reverted";
const capitalized = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** A pool as a finding names it: "Uniswap v3 0x1234…abcd", or for v4 its pool id, "hooked Uniswap v4 pool 0x1234…abcd". */
function poolName(pool: Pool): string {
  if (pool.version !== "v4") return `${VENUE[pool.version]} ${shortAddress(pool.address)}`;
  const hooks = pool.key && BigInt(pool.key.hooks) !== 0n ? "hooked" : "hookless";
  return `${hooks} ${VENUE.v4} pool ${shortAddress(pool.poolId ?? pool.address)}`;
}

/** The fallback pool as a finding names it: "the Uniswap v2 pair (0x1234…abcd)", "the hookless Uniswap v4 pool (0x…)". */
const fallbackName = (pool: Pool): string =>
  pool.version === "v2" ? `the ${VENUE.v2} pair (${shortAddress(pool.address)})` : `the hookless ${VENUE.v4} pool (${shortAddress(pool.poolId ?? pool.address)})`;

/** Why a sell into `pool` can revert on the pool's own account (`poolCanRefuseSell`). */
const poolRefusal = (pool: Pool): string =>
  pool.version === "v4"
    ? "The pool's hook runs inside every swap and can refuse one the token itself would allow."
    : `${VENUE[pool.version]} pools refuse a token that arrives short (a transfer tax), so a tax alone reverts this sell.`;

/** Why a second round trip the RPC didn't complete wasn't measured. */
const rpcNote = (attempt: TradeAttempt): string =>
  attempt.kind === "no-answer" ? "the RPC didn't run it" : attempt.kind === "timed-out" ? "it didn't answer in time" : "the RPC refused it or didn't answer";

/**
 * The finding for a buy that went through and a sell that reverted. In a Uniswap v2 pair or a hookless v4 pool only the
 * token can have refused the sell: `fail`. A Uniswap v3, Aerodrome or hooked v4 pool can refuse it on its own account, so
 * the round trip was tried again on the deepest v2 or hookless v4 USDC pool that can trade (`fallbackPool`). Only a sell
 * there that went through and brought USDC back softens the `fail` to a `warn`, naming both pools, and so does a second
 * round trip the RPC didn't run or answer (no answer from the token at all). Everything else the token can bring about
 * keeps the `fail`, with a note on what the second round trip came to:
 * - no such pool, or one whose buy reverted or that paid nothing out (it doesn't trade, whatever discovery read);
 * - a sell there that reverted too;
 * - a second round trip that ran out of the gas it is given, buying or selling, or reverted as a whole: undecided;
 * - a buy there that the pool paid out for and of which no tokens arrived: "Buying delivers no tokens";
 * - tokens bought there that the pool would give nothing back for, so no sell was sent: undecided;
 * - a sell there that went through and brought nothing back.
 */
function sellRevertedFinding(run: Extract<TradeAttempt, { kind: "ran" }>, label: string, at: { evidenceUrl: string }): Finding {
  const { pool } = run;
  const paid = usdcAmount(run.amount);
  if (!poolCanRefuseSell(pool)) {
    return finding("trade", "fail", "Can't be sold", `Buying with ${paid} USDC on ${VENUE[pool.version]} went through. ${capitalized(SOLD_BACK_REVERTED)}.`, at);
  }
  const deepestPool = `${label} (${poolName(pool)})`;
  const warnTitle = `Can't be sold into ${label}`;
  const first = `Buying with ${paid} USDC from ${deepestPool} went through. ${capitalized(SOLD_BACK_REVERTED)}. ${poolRefusal(pool)}`;
  const second = run.second;
  const fail = (detail: string, title = "Can't be sold") => finding("trade", "fail", title, detail, at);
  if (!second) return fail(`${first} It has no ${VENUE.v2} or hookless ${VENUE.v4} USDC pool that trades to try selling into instead.`);
  const other = fallbackName(second.pool);
  if (buyDidNotTrade(second)) {
    const how = second.kind === "ran" && second.result.status === STATUS.buyReverted ? "reverted" : "got nothing";
    return fail(`${first} Buying from ${other} to try selling there instead ${how}, so it has no other pool that trades to sell into.`);
  }
  if (second.kind === "no-answer" || second.kind === "call-failed" || second.kind === "timed-out") {
    return finding(
      "trade", "warn", warnTitle,
      `Selling into ${deepestPool} reverted; a round trip on ${other} couldn't be completed (${rpcNote(second)}), so selling it elsewhere wasn't shown either way. ${poolRefusal(pool)} ${SIMULATED}`,
      at,
    );
  }
  const undecided = (what: string) => fail(`${first} ${what}, which shows nothing either way, so it doesn't count as a pool the token sells into.`);
  if (second.kind === "call-reverted") return undecided(`The simulation in ${other}, tried instead, reverted or ran out of its gas as a whole`);
  const r = second.result;
  if (r.status === STATUS.buyOutOfGas || r.status === STATUS.sellOutOfGas) {
    return undecided(`${r.status === STATUS.buyOutOfGas ? "Buying" : "Selling"} in ${other}, tried instead, used up all the gas the simulation gives it`);
  }
  if (r.status === STATUS.sellReverted) {
    return fail(`Selling into ${deepestPool} reverted, and so did selling into ${other}: each time straight back, in the same transaction and from a contract.`);
  }
  if (r.status !== STATUS.ok) return undecided(`The simulation in ${other}, tried instead, answered with a status it never gives`);
  if (r.bought === 0n) {
    return fail(
      `Selling into ${deepestPool} reverted. Buying from ${other} to try selling there instead went through and the pool paid out, but none of the tokens arrived. ${SIMULATED}`,
      "Buying delivers no tokens",
    );
  }
  if (r.sold === 0n) return undecided(`Buying from ${other}, tried instead, went through, but the pool would give nothing back for the tokens bought, so no sell was sent`);
  const toSix = (raw: bigint) => toSixDecimals(raw, second.decimals);
  if (r.received === 0n) {
    return fail(`${first} Selling into ${other}, tried instead, went through, but nothing came back for ${usdcAmount(toSix(r.spent))} USDC of tokens. ${SIMULATED}`);
  }
  const back = `${usdcAmount(toSix(r.spent))} USDC came back as ${usdcAmount(toSix(r.received))}`;
  return finding(
    "trade", "warn", warnTitle,
    `Selling into ${deepestPool} reverted; selling into ${other} went through (${back}). ${poolRefusal(pool)} ${SIMULATED}`,
    at,
  );
}

/**
 * Check 10: buy the token with USDC and sell it straight back, in every USDC pool discovery found liquid and then every
 * hookless one it didn't where the token could still trade, up to six, each in its own eth_call (see `tradeCandidates` and
 * `simulateTrade`). Each round trip is judged on its own (`attemptFinding`): a buy that can't trade, a leg out of gas, an
 * RPC that didn't run it or answer in time: `unknown`; a sell that reverted: `fail` (see `sellRevertedFinding` for a pool
 * that can refuse a sell itself); a buy the pool paid out for with nothing arriving: `fail`; otherwise the measured loss, a
 * `warn` above the pool's fees plus 3% (5% where the fee can change). Only a pool that couldn't trade on its own account
 * (`poolCouldNotTrade`) is left out; a buy that reverted counts, in any pool. The finding is the worst of the rest, naming its pool: any `fail` is the finding; `unknown` only when every
 * pool counted was. A `pass` needs every round trip counted to pass, one of them in a liquid pool, and none of these, each
 * of which caps it at `warn`: a pool counted that read `unknown`, more pools to try than were tried, another pool of the
 * scan that is liquid or undecided and wasn't traded against (hooked, against EURC), or a pool deeper than one measured
 * that wasn't (a v2 pair with no tokens aside). No DEX, no trade quote (`tradeSetup`), no pool scan or no USDC pool: `unknown`.
 */
export async function checkTrade(input: InspectInput, scan: PoolScan | null): Promise<Finding> {
  if (!input.dex) return finding("trade", "unknown", "Trades aren't simulated on this network", "No DEX registry is configured here.");
  // What the round trip buys with, and how it is funded, is the chain's (on Arc, USDC through the native balance).
  const setup = tradeSetup(input);
  if (!setup) return finding("trade", "unknown", "Trades aren't simulated on this network", "No currency to trade with is configured here.");
  if (scan === null) return finding("trade", "unknown", TRADE_UNKNOWN, "The network didn't answer the pool lookup.");
  const run = await simulateTrade(input.reader, input.address, scan, setup, input.deadlineAt);
  if (run.kind === "no-pool") {
    const why = !scan.factoriesAnswered ? FACTORIES_SILENT : (silentNote(scan) ?? "No USDC pool was found to trade against.");
    return finding("trade", "unknown", TRADE_UNKNOWN, why);
  }
  const { attempts } = run;
  const many = attempts.length > 1;
  const measured = new Set<Pool>(attempts.map((a) => a.pool));
  const each = attempts.map((attempt) => {
    const f = attemptFinding(input, attempt, poolLabel(attempt.pool, scan));
    return { attempt, f: many ? { ...f, detail: `${poolName(attempt.pool)}: ${f.detail}` } : f };
  });
  // A pool that couldn't trade on its own account (the simulator found it can't serve the buy, or it paid nothing out) is
  // left out: nothing the token does brings that about, and anyone can make such a pool. Everything else counts, a buy
  // that reverted (the token may refuse a buyer it can tell is simulated) and a sell it blocks above all.
  const ignored = each.filter((e) => poolCouldNotTrade(e.attempt));
  const counted = each.filter((e) => !ignored.includes(e));
  const ignoredNote =
    ignored.length > 0
      ? ` ${capitalized(listWith("and", ignored.map((e) => poolName(e.attempt.pool))))} couldn't trade on ${ignored.length === 1 ? "its" : "their"} own account (no liquidity at ${ignored.length === 1 ? "its" : "their"} price, or nothing for the amount), so ${ignored.length === 1 ? "it doesn't" : "they don't"} count.`
      : "";
  if (counted.length === 0) return { ...each[0]!.f, detail: `${each[0]!.f.detail}${many ? ignoredNote : ""}` };

  // The worst round trip decides: any fail is the finding. Otherwise the worst of the rest, a sell refused by one pool
  // before a loss, the larger loss first; unknowns only when nothing else was measured.
  const fail = counted.find((e) => e.f.status === "fail");
  if (fail) return many ? { ...fail.f, detail: `${fail.f.detail} It is the worst of the round trips in ${attempts.length} pools.` } : fail.f;
  const known = counted.filter((e) => e.f.status !== "unknown");
  const unknown = counted.filter((e) => e.f.status === "unknown");
  if (known.length === 0) return { ...unknown[0]!.f, detail: `${unknown[0]!.f.detail}${ignoredNote}` };
  const rank = (e: (typeof each)[number]): bigint => (e.f.status === "warn" ? (lossOf(e.attempt) ?? 10n ** 9n) + 10n ** 7n : (lossOf(e.attempt) ?? 0n));
  const worst = known.reduce((x, y) => (rank(y) > rank(x) ? y : x));
  const f = worst.f;
  const unknownNote =
    unknown.length > 0
      ? ` ${capitalized(listWith("and", unknown.map((e) => poolName(e.attempt.pool))))} couldn't be measured (${listWith("and", unknown.map((e) => lowerFirst(e.f.detail.replace(/^[^:]*: /, "").replace(/\.$/, ""))))}).`
      : "";
  const allNote = many && f.status === "pass" && unknown.length === 0 ? ` Round trips in all ${counted.length} pools counted went through; the worst is shown.` : "";

  // What keeps a measured round trip from a pass, whatever it measured: a pool counted that couldn't be measured, more pools
  // than were tried, no liquid pool among those measured, any other pool the scan found that is liquid or of undecided
  // liquidity (hooked, against EURC), or a pool deeper than one measured that wasn't (a v2 pair with no tokens aside).
  // Each caps at a warning.
  const liquidMeasured = counted.filter((e) => e.attempt.pool.liquid === true).map((e) => e.attempt.pool);
  const thin = liquidMeasured.length === 0 ? counted[0]!.attempt.pool : null;
  const tooMany = run.candidates > attempts.length;
  const otherLive = scan.pools.filter((p) => !measured.has(p) && (p.liquid === true || p.liquid === null));
  const reference = liquidMeasured.length > 0 ? liquidMeasured : counted.map((e) => e.attempt.pool);
  const shallowest = reference.reduce((m, p) => (orderDepth(p) < m ? orderDepth(p) : m), orderDepth(reference[0]!));
  // A pool left out as unable to trade is no measurement: deeper than a pool measured, it caps as any untried pool does.
  const countedPools = new Set<Pool>(counted.map((e) => e.attempt.pool));
  const deeper = scan.pools.filter((p) => !countedPools.has(p) && !otherLive.includes(p) && p.tradable !== false && orderDepth(p) > shallowest);
  const notes = [
    thin
      ? ` It was measured on ${thin.liquid === null ? "a pool whose liquidity is undecided" : "a thin pool"} (${poolName(thin)}, ${usdcAmount(thin.depth)} ${thin.quote}${thin.version === "v4" ? " in range" : ""}).`
      : "",
    tooMany ? ` It has ${run.candidates} pools to try; ${attempts.length} were tried.` : "",
    otherLive.length > 0
      ? ` ${capitalized(listWith("and", otherLive.map((p) => `${untriedName(p, setup)} (${p.liquid === true ? "liquid" : "liquidity undecided"})`)))} ${otherLive.length === 1 ? "wasn't" : "weren't"} traded against.`
      : "",
    deeper.length > 0
      ? ` ${capitalized(listWith("and", deeper.map((p) => untriedName(p, setup))))}, deeper than a pool measured, ${deeper.length === 1 ? "wasn't" : "weren't"} measured.`
      : "",
  ].join("");
  if (f.status === "pass" && (unknown.length > 0 || notes !== "")) {
    const title =
      unknown.length > 0 ? "A pool couldn't be measured"
      : tooMany ? `${run.candidates} pools; ${attempts.length} were tried`
      : thin ? (thin.liquid === null ? "Measured on a pool of undecided liquidity" : "Measured on a thin pool")
      : otherLive.length > 0 ? (otherLive.some((p) => p.liquid === true) ? "Another liquid pool wasn't measured" : "A pool of undecided liquidity wasn't measured")
      : "A deeper pool wasn't measured";
    const why = " A pass needs a round trip that went through in a liquid pool and in every other pool tried, and no liquid or undecided pool left untried.";
    return { ...f, status: "warn", title, detail: `${f.detail}${unknownNote}${ignoredNote}${notes}${why}` };
  }
  return { ...f, detail: `${f.detail}${allNote}${unknownNote}${ignoredNote}${notes}` };
}

/** `text` with its first letter in lower case. */
const lowerFirst = (text: string) => `${text[0]!.toLowerCase()}${text.slice(1)}`;

/** A round trip's measured loss in ppm, or `null` when it didn't measure one. */
function lossOf(attempt: TradeAttempt): bigint | null {
  if (attempt.kind !== "ran" || attempt.result.status !== STATUS.ok || attempt.result.spent === 0n) return null;
  const r = attempt.result;
  return r.received >= r.spent ? 0n : ((r.spent - r.received) * 1_000_000n) / r.spent;
}

/** A pool never traded against, with what it trades against when that isn't the trade's currency (USDC): "Uniswap v3 0x1234…abcd (EURC)". */
const untriedName = (p: Pool, setup: TradeSetup): string => (p.quote === setup.symbol ? poolName(p) : `${poolName(p)} (${p.quote})`);

/**
 * What to call a pool measured: "its deepest pool" when the scan found none deeper; otherwise "a liquid pool" for one found
 * liquid, or "the deepest pool the check trades against" for the one pool measured when none is liquid.
 */
function poolLabel(pool: Pool, scan: PoolScan): string {
  if (!scan.pools.some((p) => p !== pool && orderDepth(p) > orderDepth(pool))) return "its deepest pool";
  return pool.liquid === true ? "a liquid pool" : "the deepest pool the check trades against";
}

/** The finding for one pool's round trip; `label` is what to call that pool ("its deepest pool"). */
function attemptFinding(input: InspectInput, run: TradeAttempt, label: string): Finding {
  const { pool } = run;
  const at = { evidenceUrl: `${input.explorerBase}/address/${pool.address}` };
  const venue = VENUE[pool.version];
  if (run.kind === "call-reverted") {
    return finding("trade", "unknown", TRADE_UNKNOWN, "The simulation reverted or ran out of its gas as a whole, which says nothing about selling.", at);
  }
  if (run.kind === "no-answer") {
    return finding("trade", "unknown", TRADE_UNKNOWN, "The RPC didn't run the simulation: it needs eth_call to accept a state override.", at);
  }
  if (run.kind === "call-failed") {
    return finding("trade", "unknown", TRADE_UNKNOWN, "The RPC refused the simulation or didn't answer.", at);
  }
  if (run.kind === "timed-out") {
    return finding("trade", "unknown", TRADE_UNKNOWN, "The simulation didn't answer in time.", at);
  }
  if (run.kind === "ran" && run.result.status === STATUS.amountOverLimit) {
    return finding("trade", "unknown", TRADE_UNKNOWN, `One raw unit of the token costs more at the pool's price, on ${VENUE[pool.version]}, than the most the simulation buys with there, so it wasn't bought.`, at);
  }
  if (run.kind === "ran" && run.result.status === STATUS.poolCantTrade) {
    return finding("trade", "unknown", TRADE_UNKNOWN, `The pool on ${VENUE[pool.version]} can't serve a buy: it has no liquidity at its price, or gives nothing for the amount.`, at);
  }
  const { result } = run;
  const toSix = (raw: bigint) => toSixDecimals(raw, run.decimals);
  const paid = usdcAmount(run.amount);
  switch (result.status) {
    case STATUS.buyReverted:
      return finding("trade", "unknown", TRADE_UNKNOWN, `Buying with ${paid} USDC on ${venue} reverted, so selling couldn't be tried.`, at);
    case STATUS.buyOutOfGas:
      return finding("trade", "unknown", TRADE_UNKNOWN, `Buying on ${venue} used up all the gas the simulation gives it, so selling couldn't be tried.`, at);
    case STATUS.sellOutOfGas:
      return finding("trade", "unknown", TRADE_UNKNOWN, `Buying on ${venue} went through, and selling back used up all the gas the simulation gives it, which says nothing either way.`, at);
    case STATUS.sellReverted:
      return sellRevertedFinding(run, label, at);
    case STATUS.ok:
      break;
    default:
      return finding("trade", "unknown", TRADE_UNKNOWN, "The simulation answered with a status it never gives.", at);
  }
  if (result.spent === 0n) return finding("trade", "unknown", TRADE_UNKNOWN, `The buy on ${venue} took no USDC, so there is no round trip to measure.`, at);
  if (result.bought === 0n) {
    return result.paidOut > 0n
      ? finding("trade", "fail", "Buying delivers no tokens", `Buying with ${usdcAmount(toSix(result.spent))} USDC on ${venue} went through and the pool paid out, but none of the tokens arrived, so nothing could be sold back. ${SIMULATED}`, at)
      : finding("trade", "unknown", TRADE_UNKNOWN, `The buy on ${venue} took USDC and the pool paid out nothing, so there is no round trip to measure.`, at);
  }
  const loss = result.received >= result.spent ? 0n : ((result.spent - result.received) * 1_000_000n) / result.spent;
  const fees = roundTripFee(pool);
  const line = fees === null ? TRADE_LINE_VARIABLE_FEE : fees + TRADE_SLACK;
  const spent = usdcAmount(toSix(result.spent));
  const back = usdcAmount(toSix(result.received));
  const what =
    result.received > result.spent
        ? `Bought with ${spent} USDC on ${venue} and sold straight back for ${back} USDC, more than went in.`
        : `Bought with ${spent} USDC on ${venue} and sold straight back for ${back} USDC: ${ppmPct(loss)} lost.`;
  const unsold = result.sold < result.bought ? " Not every token bought could be sold back." : "";
  const norm =
    fees === null
      ? "This pool's fee can change from one swap to the next, so up to 5% counts as fees."
      : `The pool's fees for the two swaps come to ${ppmPct(fees)}.`;
  const detail = `${what}${unsold} ${norm} ${SIMULATED}`;
  return loss > line
    ? finding("trade", "warn", `A round trip loses ${ppmPct(loss)}`, detail, at)
    : finding("trade", "pass", "Bought and sold back in a simulation", detail, at);
}
