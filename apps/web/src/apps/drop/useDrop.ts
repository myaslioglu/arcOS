"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, parseEventLogs } from "viem";
import { ARCOS, activeChain, activeNetwork, multisendAbi, unitsToNative, type Address } from "@arcos/chain";
import { BATCH, chunk, type DropRow } from "./parse";
import { failedRowsFor, type FailedRow } from "./result";

export type DropProgress = { batch: number; batches: number; step: "approve" | "send" };
export type DropResult = { delivered: number; failed: FailedRow[]; hashes: string[] };

/** token === null sends native USDC; row amounts are then 6-decimal units. */
export function useDrop() {
  const chain = activeChain();
  const multisend = ARCOS[activeNetwork()]?.multisend;
  const { address } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const [progress, setProgress] = useState<DropProgress | null>(null);

  const quoteTotal = useCallback(
    async (count: number): Promise<bigint> => {
      if (!client || !multisend) return 0n;
      const sizes = chunk(Array.from({ length: count }), BATCH).map((b) => BigInt(b.length));
      const fees = await Promise.all(
        sizes.map((n) => client.readContract({ address: multisend, abi: multisendAbi, functionName: "quote", args: [n] })),
      );
      return fees.reduce((a, b) => a + b, 0n);
    },
    [client, multisend],
  );

  const send = useCallback(
    async (token: Address | null, rows: DropRow[]): Promise<DropResult> => {
      if (!client || !multisend || !address) throw new Error("Wallet or network isn't ready.");
      const batches = chunk(rows, BATCH);
      const result: DropResult = { delivered: 0, failed: [], hashes: [] };

      if (token) {
        const total = rows.reduce((s, r) => s + r.amount, 0n);
        const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, multisend] });
        if (allowance < total) {
          setProgress({ batch: 0, batches: batches.length, step: "approve" });
          const hash = await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [multisend, total], chainId: chain.id });
          await client.waitForTransactionReceipt({ hash });
        }
      }

      for (const [i, batch] of batches.entries()) {
        setProgress({ batch: i + 1, batches: batches.length, step: "send" });
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
        const failures = parseEventLogs({ abi: multisendAbi, logs: receipt.logs, eventName: "TransferFailed" });
        result.hashes.push(hash);
        // `index` on each TransferFailed log is the row's position within THIS batch, so it must be mapped
        // back to the CSV line using this same batch, not the full row list.
        result.failed.push(...failedRowsFor(batch, failures));
        result.delivered += batch.length - failures.length;
      }
      setProgress(null);
      return result;
    },
    [client, multisend, address, chain.id, writeContractAsync],
  );

  return { ready: !!multisend && !!client && !!address, progress, quoteTotal, send };
}
