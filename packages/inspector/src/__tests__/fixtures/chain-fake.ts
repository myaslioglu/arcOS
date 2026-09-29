import { CallReverted, type ChainReader } from "../../types";

/**
 * A fake chain for the pool tests. Reads are keyed like the ones in inspect.test.ts: `"<address>.<fn>(<args>)"`, all
 * lowercase, args joined by commas. A value that is an `Error` is thrown, and a key that isn't there reverts, which is what
 * a contract answering "no" looks like to the engine.
 */
export type FakeChain = {
  code?: Record<string, string>;
  reads?: Record<string, unknown>;
};

/** What a fake reader was asked, in order. */
export type ReadRecord = { address: string; fn: string; args: readonly unknown[] };
export type FakeReader = ChainReader & { asked: ReadRecord[] };

export const readKey = (address: string, fn: string, args: readonly unknown[]): string =>
  `${address.toLowerCase()}.${fn}(${args.map((x) => String(x).toLowerCase()).join(",")})`;

export function fakeChain(f: FakeChain = {}): FakeReader {
  const asked: ReadRecord[] = [];
  return {
    asked,
    getCode: async (a) => (f.code?.[a.toLowerCase()] as `0x${string}` | undefined) ?? null,
    getStorageAt: async () => null,
    read: async (address, _abi, fn, args = []) => {
      asked.push({ address, fn, args });
      const key = readKey(address, fn, args);
      if (!f.reads || !(key in f.reads)) throw new CallReverted();
      const value = f.reads[key];
      if (value instanceof Error) throw value;
      return value;
    },
    blockNumber: async () => 123n,
  };
}
