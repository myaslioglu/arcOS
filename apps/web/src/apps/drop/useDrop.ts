"use client";

import { useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, parseEventLogs } from "viem";
import { ARCOS, activeChain, activeNetwork, multisendAbi, unitsToNative, type Address } from "@arcos/chain";
import { BATCH, batchSizes, chunk, formatDropList, type DropRow } from "./parse";
import { isUserRejection, runDrop, shortMessage, type BatchOutcome, type DropResult } from "./runDrop";
import { session } from "./session";

export type { DropResult } from "./runDrop";
export type { DropProgress } from "./session";

/** token === null sends native USDC; row amounts are then 6-decimal units. */
export function useDrop() {
  const chain = activeChain();
  const multisend = ARCOS[activeNetwork()]?.multisend;
  const { address } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();

  const quoteTotal = useCallback(
    async (count: number): Promise<bigint | null> => {
      if (!client || !multisend) return 0n;
      const sizes = batchSizes(count, BATCH).map(BigInt);
      try {
        const fees = await Promise.all(
          sizes.map((n) => client.readContract({ address: multisend, abi: multisendAbi, functionName: "quote", args: [n] })),
        );
        return fees.reduce((a, b) => a + b, 0n);
      } catch {
        return null; // the caller shows "Couldn't read the fee." instead of hanging on "Reading the fee…"
      }
    },
    [client, multisend],
  );

  // Reports progress and the final result into the session store (see ./session), not component state:
  // the store survives this component unmounting (the window closing) mid-send, where local state would
  // just vanish and orphan the loop. Every path out of this function — including the defensive guards
  // below — calls `session.finish` exactly once before returning, so the session can never get stuck
  // reporting "sending" forever (which would also block any future send, since the store refuses to start
  // a second one while one is already in flight).
  const send = useCallback(
    async (token: Address | null, rows: DropRow[], decimals: number) => {
      if (!client || !multisend || !address) {
        const result: DropResult = {
          delivered: [],
          failed: [],
          remaining: rows,
          hashes: [],
          stoppedBecause: "error" as const,
          message: "Wallet or network isn't ready.",
        };
        session.finish(result, formatDropList(rows, token, decimals));
        return result;
      }

      const batches = chunk(rows, BATCH);

      try {
        if (token) {
          const total = rows.reduce((s, r) => s + r.amount, 0n);
          try {
            const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, multisend] });
            if (allowance < total) {
              session.setProgress({ batch: 0, batches: batches.length, step: "approve" });
              const hash = await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [multisend, total], chainId: chain.id });
              await client.waitForTransactionReceipt({ hash });
            }
          } catch (err) {
            // A refused or failed approval never reaches the send loop: nothing was attempted, so every
            // row is still in `remaining` rather than this throwing past the caller.
            const result: DropResult = {
              delivered: [],
              failed: [],
              remaining: rows,
              hashes: [],
              stoppedBecause: isUserRejection(err) ? ("rejected" as const) : ("error" as const),
              message: shortMessage(err),
            };
            session.finish(result, formatDropList(rows, token, decimals));
            return result;
          } finally {
            session.setProgress(null);
          }
        }

        const sendBatch = async (batch: DropRow[], batchNumber: number): Promise<BatchOutcome> => {
          session.setProgress({ batch: batchNumber, batches: batches.length, step: "send" });
          const to = batch.map((r) => r.address);
          const amounts = batch.map((r) => (token ? r.amount : unitsToNative(r.amount)));
          const fee = await client.readContract({ address: multisend, abi: multisendAbi, functionName: "quote", args: [BigInt(batch.length)] });
          // Simulate first: a revert here costs nothing and gives a readable reason. Each branch calls
          // writeContractAsync with its own `request` rather than joining them through a shared variable —
          // a ternary here defeats overload resolution between sendToken's and sendNative's request shapes.
          let hash: `0x${string}`;
          if (token) {
            const { request } = await client.simulateContract({ account: address, address: multisend, abi: multisendAbi, functionName: "sendToken", args: [token, to, amounts], value: fee });
            hash = await writeContractAsync(request);
          } else {
            const { request } = await client.simulateContract({ account: address, address: multisend, abi: multisendAbi, functionName: "sendNative", args: [to, amounts], value: amounts.reduce((s, a) => s + a, 0n) + fee });
            hash = await writeContractAsync(request);
          }
          const receipt = await client.waitForTransactionReceipt({ hash });
          // Filtered to the Multisend contract's own logs: without it, any other log in the same transaction
          // that happens to match the TransferFailed signature would be misread as one of this batch's rows.
          // (This viem version's parseEventLogs has no `address` filter of its own.)
          const failures = parseEventLogs({ abi: multisendAbi, logs: receipt.logs, eventName: "TransferFailed" }).filter(
            (log) => log.address.toLowerCase() === multisend.toLowerCase(),
          );
          return {
            hash,
            status: receipt.status === "reverted" ? "reverted" : "success",
            failures: failures.map((f) => ({ index: Number(f.args.index), amount: f.args.amount })),
          };
        };

        const result = await runDrop(rows, BATCH, { sendBatch });
        session.finish(result, formatDropList(result.remaining, token, decimals));
        return result;
      } catch (err) {
        // `runDrop` itself never throws (every sendBatch failure is caught and turned into a DropResult) —
        // this is a defensive net for anything truly unexpected, so the session store still reaches "done"
        // instead of being stuck reporting "sending" forever.
        const result: DropResult = {
          delivered: [],
          failed: [],
          remaining: rows,
          hashes: [],
          stoppedBecause: "error" as const,
          message: shortMessage(err),
        };
        session.finish(result, formatDropList(rows, token, decimals));
        throw err;
      }
    },
    [client, multisend, address, chain.id, writeContractAsync],
  );

  return { ready: !!multisend && !!client && !!address, quoteTotal, send };
}
