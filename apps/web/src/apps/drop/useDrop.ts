"use client";

import { useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, parseEventLogs, type PublicClient } from "viem";
import { ARCOS, FEE_KEYS, activeChain, activeNetwork, feeControllerAbi, formatUsdc, multisendAbi, unitsToNative, type Address } from "@arcos/chain";
import { describeContractError } from "@/lib/contract-error";
import { dropBatchFee, dropTotalFee } from "./dropFee";
import { BATCH, batchSizes, chunk, formatDropList, type DropRow } from "./parse";
import { isUserRejection, runDrop, type BatchOutcome, type DropResult } from "./runDrop";
import { session } from "./session";

export type { DropResult } from "./runDrop";
export type { DropProgress } from "./session";

/** The two raw fee inputs a quote was computed from (DROP_PER_RECIPIENT, DROP_MIN — both native wei).
 * Kept around, not just the computed total, so a later batch can re-read the same two values and
 * detect a change instead of only ever comparing an opaque total. */
export type DropFeeBasis = { perRecipient: bigint; min: bigint };
export type DropQuote = { total: bigint; basis: DropFeeBasis };

/** token === null sends native USDC; row amounts are then 6-decimal units. */
export function useDrop() {
  const chain = activeChain();
  const contracts = ARCOS[activeNetwork()];
  const multisend = contracts?.multisend;
  const feeController = contracts?.feeController;
  const { address } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();

  const readFeeBasis = useCallback(
    async (c: PublicClient): Promise<DropFeeBasis> => {
      const [perRecipient, min] = await Promise.all([
        c.readContract({ address: feeController!, abi: feeControllerAbi, functionName: "feeOf", args: [FEE_KEYS.DROP_PER_RECIPIENT] }),
        c.readContract({ address: feeController!, abi: feeControllerAbi, functionName: "feeOf", args: [FEE_KEYS.DROP_MIN] }),
      ]);
      return { perRecipient, min };
    },
    [feeController],
  );

  const quoteTotal = useCallback(
    async (count: number): Promise<DropQuote | null> => {
      // null (never a 0 total): "no fee to show yet", not "this send is free" — the caller shows
      // "Couldn't read the fee. Try again." instead of a reassuring but wrong number.
      if (!client || !feeController) return null;
      try {
        const basis = await readFeeBasis(client);
        const total = dropTotalFee(basis.perRecipient, basis.min, batchSizes(count, BATCH));
        return { total, basis };
      } catch {
        return null;
      }
    },
    [client, feeController, readFeeBasis],
  );

  // Reports progress and the final result into the session store (see ./session), not component state:
  // the store survives this component unmounting (the window closing) mid-send, where local state would
  // just vanish and orphan the loop. Every path out of this function — including the defensive guards
  // below — calls `session.finish` exactly once before returning, so the session can never get stuck
  // reporting "sending" forever (which would also block any future send, since the store refuses to start
  // a second one while one is already in flight).
  const send = useCallback(
    async (token: Address | null, rows: DropRow[], decimals: number, shownFee: DropFeeBasis | null) => {
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
              message: describeContractError(err),
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

          // Re-read DROP_PER_RECIPIENT and DROP_MIN fresh, right before this batch signs — not the
          // basis the form last showed — and recompute the fee: a multi-batch send can straddle a fee
          // change mid-run, so every batch gets its own check, not just the first. A mismatch stops
          // here, before the wallet opens; runDrop's existing catch handling puts this batch and every
          // batch after it back into `remaining` as a normal partial result.
          const fresh = await readFeeBasis(client);
          const fee = dropBatchFee(fresh.perRecipient, fresh.min, batch.length);
          if (shownFee && (fresh.perRecipient !== shownFee.perRecipient || fresh.min !== shownFee.min)) {
            throw new Error(`The fee changed to ${formatUsdc(fee)} USDC. Check it and submit again.`);
          }

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
          message: describeContractError(err),
        };
        session.finish(result, formatDropList(rows, token, decimals));
        throw err;
      }
    },
    [client, multisend, address, chain.id, writeContractAsync, readFeeBasis],
  );

  return { ready: !!multisend && !!client && !!address, quoteTotal, send };
}
