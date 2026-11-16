/**
 * The chain's time, as the vault contracts see it: `block.timestamp`. A lock unlocks by it, not by the visitor's
 * clock, which can be minutes off (and, on a local test chain whose time was moved forward, days). One latest block is
 * read (useChainClock), and the time since that read is added on.
 */
export type ClockSample = {
  /** The latest block's timestamp, unix seconds. */
  chain: number;
  /** When it was read, in local milliseconds. */
  at: number;
};

/** The chain's time at local time `nowMs`, from `sample`; the local clock itself when there is no sample yet. */
export function chainNow(sample: ClockSample | undefined, nowMs: number): number {
  if (!sample) return Math.floor(nowMs / 1000);
  return sample.chain + Math.max(0, Math.floor((nowMs - sample.at) / 1000));
}
