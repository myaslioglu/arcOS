/**
 * What V4Quoter.quoteExactOutputSingle reverts with, read from Arc mainnet with eth_call on 2026-09-29 (blocks around
 * 23,41x,xxx). The quoter runs the swap inside the PoolManager's unlock and wraps whatever the inner call reverted with in
 * `UnexpectedRevertBytes(bytes)` (selector 0x6190b2b0), so the inner reason is what tells the cases apart.
 */

/** UnexpectedRevertBytes(NotEnoughLiquidity(poolId)): the pool ran out of liquidity before it had paid the amount out. Asked
 * for 10,000,000 USDC out of the USDC/EURC 0.05% pool, pool id below. The empty spacing-1 pools answer the same after walking
 * every tick word (20 to 30 million gas). */
export const NOT_ENOUGH_LIQUIDITY_POOL = "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae";
export const NOT_ENOUGH_LIQUIDITY =
  "0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed734eb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae00000000000000000000000000000000000000000000000000000000";

/** The same answer for another pool id (the empty EURC/USDC 0.01% spacing-1 pool, default gas). */
export const NOT_ENOUGH_LIQUIDITY_OTHER_POOL =
  "0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed734d38a719812973a04b7c2a5fde43ea8c5f27cb3bd4a419bb27f5a380bfedb5ff900000000000000000000000000000000000000000000000000000000";

/** UnexpectedRevertBytes(0x): an EMPTY inner reason. The inner call ran out of gas (the honest USDC/EURC pool with `gas` 60,000; a
 * spacing-1 pool with anything under about 20 million) and the quoter's catch saw nothing. Says nothing about liquidity. */
export const EMPTY_INNER_REASON =
  "0x6190b2b000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";

/** UnexpectedRevertBytes(PoolNotInitialized()): no such pool. */
export const POOL_NOT_INITIALIZED =
  "0x6190b2b000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004486aa30700000000000000000000000000000000000000000000000000000000";
