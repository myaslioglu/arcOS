"use client";

import { useCallback } from "react";
import { getConnection } from "wagmi/actions";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, parseEventLogs, type PublicClient } from "viem";
import { ARCOS, FEE_KEYS, activeChain, activeNetwork, arcVestingAbi, feeControllerAbi, vestingFactoryAbi, type Address } from "@arcos/chain";
import { describeContractError, isUserRejection, UserFacingError } from "@/lib/contract-error";
import { assertWalletOnChain, withChain } from "@/lib/paid-write";
import { notifyBalanceChanged } from "@/lib/balance-refresh";
import { displayWei } from "@/lib/display-amount";
import type { DropRow } from "@/lib/recipient-list";
import { wagmiConfig } from "@/providers/wagmi";
import { tokenCache } from "./added";
import type { FormState, Terms } from "./form";
import { runVesting, type RowOutcome } from "./runVesting";
import { session } from "./session";

/** ZeroAmount for a schedule: the factory reverts it for a zero amount, and when the token delivered nothing (a token that takes a cut on every transfer). */
export const VESTING_ERRORS = { ZeroAmount: "The amount is zero, or the token delivered nothing. A token that takes a cut on every transfer can do that." } as const;

/**
 * After a wallet error that may have followed a send: the schedule this row would have made, if the factory now lists a new
 * one for the beneficiary that this creator made with this token. Null when there is none to be found.
 */
export async function findCreated(
  client: Pick<PublicClient, "readContract" | "getContractEvents">,
  factory: Address,
  creator: Address,
  token: Address,
  row: DropRow,
  before: bigint,
  fromBlock: bigint,
): Promise<RowOutcome | null> {
  try {
    const after = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "vestingsOfLength", args: [row.address] });
    if (after <= before) return null;
    const added = (await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "vestingsOfSlice", args: [row.address, before, after - before] })).map((a) => a.toLowerCase());
    const logs = await client.getContractEvents({ address: factory, abi: vestingFactoryAbi, eventName: "VestingCreated", args: { creator, token, beneficiary: row.address }, fromBlock, toBlock: "latest" });
    const log = logs.find((l) => l.args.vesting !== undefined && added.includes(l.args.vesting.toLowerCase()));
    return log && log.args.vesting ? { status: "created", hash: log.transactionHash, vesting: log.args.vesting } : null;
  } catch {
    return null;
  }
}

/** The factory's fee for one schedule, read through the factory's own FeeController, which is the one it charges from. */
export async function readVestFee(client: Pick<PublicClient, "readContract">, factory: Address): Promise<bigint> {
  const controller = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "feeController" });
  return client.readContract({ address: controller, abi: feeControllerAbi, functionName: "feeOf", args: [FEE_KEYS.VEST_FLAT] });
}

/** The chain's time now, in seconds: the latest block's timestamp, which is what the contract's own clock reads. */
export async function readChainNow(client: Pick<PublicClient, "getBlock">): Promise<bigint> {
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}

/** Creating schedules: the exact approval, then one createVesting per row, with the progress in `session`. */
export function useCreateVestings() {
  const chain = activeChain();
  const factory = ARCOS[activeNetwork()]?.vestingFactory ?? null;
  const { address, chainId: walletChainId } = useConnection();
  const client = usePublicClient({ chainId: chain.id });
  const { mutateAsync } = useWriteContract();

  const readFee = useCallback(async () => {
    if (!client || !factory) throw new Error("not ready");
    return readVestFee(client, factory);
  }, [client, factory]);

  const chainNow = useCallback(async () => {
    if (!client) throw new Error("not ready");
    return readChainNow(client);
  }, [client]);

  const run = useCallback(
    async (token: Address, symbol: string, decimals: number, rows: DropRow[], form: FormState, terms: Terms, shownFee: bigint): Promise<void> => {
      if (!client || !factory || !address) return;
      if (!session.start(token, symbol, decimals, rows, form, terms)) return;
      const total = rows.reduce((s, r) => s + r.amount, 0n);
      let approved = 0n;
      try {
        assertWalletOnChain(walletChainId, chain.id);
        // Exactly the total, once. An allowance that already covers it is left as it is.
        try {
          const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, factory] });
          if (allowance < total) {
            const hash = await mutateAsync(
              withChain({ address: token, abi: erc20Abi, functionName: "approve", args: [factory, total] } as const, chain.id),
            );
            const receipt = await client.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") throw new UserFacingError("The approval transaction failed. Nothing was created.");
            approved = total;
          }
        } catch (err) {
          session.finish({ result: null, leftoverAllowance: null, approvalMessage: describeContractError(err, VESTING_ERRORS) });
          return;
        }
        session.update({ step: "create" });

        const result = await runVesting(rows, {
          onState: (_i, _s, states) => session.setStates(states),
          createRow: async (row): Promise<RowOutcome> => {
            // The wallet's chain, read live: it may have changed since the run began.
            assertWalletOnChain(getConnection(wagmiConfig).chainId, chain.id);
            let fee: bigint;
            try {
              fee = await readFee();
            } catch {
              throw new UserFacingError("Couldn't read the fee, so the next schedule wasn't created.");
            }
            if (fee !== shownFee) {
              throw new UserFacingError(`The fee changed from ${displayWei(shownFee, "up")} to ${displayWei(fee, "up")} USDC. Check it and submit again.`);
            }
            let request;
            let before: bigint;
            let fromBlock: bigint;
            try {
              const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
              if (balance < row.amount) return { status: "failed", message: "Your balance of this token is below this amount." };
              fromBlock = await client.getBlockNumber();
              before = await client.readContract({ address: factory, abi: vestingFactoryAbi, functionName: "vestingsOfLength", args: [row.address] });
              ({ request } = await client.simulateContract({
                account: address,
                address: factory,
                abi: vestingFactoryAbi,
                functionName: "createVesting",
                args: [token, row.address, row.amount, terms.start, terms.duration, terms.cliff],
                value: fee,
              }));
            } catch (err) {
              // Nothing was sent: this row alone is refused, and the others go on.
              return { status: "failed", message: describeContractError(err, VESTING_ERRORS) };
            }
            let hash: `0x${string}`;
            try {
              hash = await mutateAsync(withChain(request, chain.id));
            } catch (err) {
              if (isUserRejection(err)) throw err;
              // Any other wallet error may have come after the transaction was sent (a lost reply from a phone wallet,
              // say). Look for the schedule before saying anything: it is never offered for a retry.
              const found = await findCreated(client, factory, address, token, row, before, fromBlock);
              return found ?? { status: "unknown" };
            }
            let receipt;
            try {
              receipt = await client.waitForTransactionReceipt({ hash });
            } catch {
              return { status: "unconfirmed", hash };
            }
            if (receipt.status === "reverted") return { status: "failed", message: "The transaction reverted. Nothing was created for this row.", hash };
            // A cancelled or replaced transaction can come back with a successful receipt that created nothing: only the
            // factory's own event for this creator, token and beneficiary counts.
            const created = parseEventLogs({ abi: vestingFactoryAbi, logs: receipt.logs, eventName: "VestingCreated" }).find(
              (l) =>
                l.address.toLowerCase() === factory.toLowerCase() &&
                l.args.creator.toLowerCase() === address.toLowerCase() &&
                l.args.token.toLowerCase() === token.toLowerCase() &&
                l.args.beneficiary.toLowerCase() === row.address.toLowerCase(),
            );
            if (!created) return { status: "unconfirmed", hash };
            tokenCache(activeNetwork()).set(created.args.vesting, token);
            return { status: "created", hash, vesting: created.args.vesting };
          },
        });

        // What the factory may still take: the approval left over after the schedules created.
        // Only reported when this run set the approval: an allowance that was already there isn't this run's to explain.
        let leftover: bigint | null = null;
        if (approved > 0n) {
          try {
            leftover = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, factory] });
          } catch {
            leftover = approved;
          }
        }
        notifyBalanceChanged();
        session.finish({ result, leftoverAllowance: leftover });
      } catch (err) {
        // runVesting never throws; this is the wallet-chain check and anything unexpected before it.
        notifyBalanceChanged();
        session.finish({
          result: { states: rows.map(() => ({ status: "not_sent" as const })), stoppedBecause: isUserRejection(err) ? "rejected" : "error", message: describeContractError(err) },
          leftoverAllowance: null,
        });
      }
    },
    [client, factory, address, walletChainId, chain.id, mutateAsync, readFee],
  );

  return { ready: !!factory && !!client && !!address, readFee, chainNow, run };
}

/** `release(token)` on one wallet. Resolves to the transaction hash once mined. */
export function useRelease() {
  const chain = activeChain();
  const { chainId: walletChainId, address } = useConnection();
  const client = usePublicClient({ chainId: chain.id });
  const { mutateAsync } = useWriteContract();
  return useCallback(
    async (wallet: Address, token: Address): Promise<string> => {
      if (!client || !address) throw new UserFacingError("Wallet or network isn't ready.");
      assertWalletOnChain(walletChainId, chain.id);
      const { request } = await client.simulateContract({
        account: address,
        address: wallet,
        abi: arcVestingAbi,
        functionName: "release",
        args: [token],
      });
      const hash = await mutateAsync(withChain(request, chain.id));
      const receipt = await client.waitForTransactionReceipt({ hash });
      notifyBalanceChanged();
      if (receipt.status !== "success") throw new UserFacingError("The release transaction reverted. Nothing was released.");
      return hash;
    },
    [client, address, walletChainId, chain.id, mutateAsync],
  );
}
