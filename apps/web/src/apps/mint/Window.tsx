"use client";

import { useState, useSyncExternalStore } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { parseEventLogs } from "viem";
import { ARCOS, FEE_KEYS, activeChain, activeNetwork, explorerUrl, feeControllerAbi, formatUsdc, tokenFactoryAbi } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { UserFacingError, describeContractError } from "@/lib/contract-error";
import { trackEvent } from "@/lib/analytics";
import { session } from "./session";
import { validateMint, type MintForm } from "./validate";

const EMPTY: MintForm = { name: "", symbol: "", decimals: "18", supply: "", mintable: false, burnable: false, cap: "" };

function Form() {
  const chain = activeChain();
  const contracts = ARCOS[activeNetwork()];
  const { address } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { open, notify } = useDesktop();
  const [form, setForm] = useState<MintForm>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof MintForm, string>>>({});

  // The mint session lives outside this component (see ./session) so it survives the window closing
  // mid-mint: a reopened window shows the pending or finished state — including the created token's
  // address — instead of a blank form that would invite a second, separately-charged mint.
  const mintSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = mintSession.status === "minting";

  const fee = useReadContract({
    address: contracts?.feeController,
    abi: feeControllerAbi,
    functionName: "feeOf",
    args: [FEE_KEYS.MINT_FLAT],
    chainId: chain.id,
    query: { enabled: !!contracts },
  });

  if (!contracts) return <p className="p-5 text-sm text-muted">{"Mint isn't deployed on this network yet."}</p>;

  const set = <K extends keyof MintForm>(key: K, value: MintForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateMint(form, address!);
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    if (fee.data === undefined || !client) return notify("Couldn't read the fee. Try again.", "warn");
    const shownFee = fee.data;
    const started = session.start(result.args.symbol);
    if (!started) return; // a mint is already in flight (another click, another window) — do nothing
    try {
      // Re-read the fee right before sending: it can change between opening the window and signing, and we
      // must not let the user pay a stale amount.
      const fresh = await fee.refetch();
      if (fresh.data === undefined) return session.fail("Couldn't read the fee. Try again.");
      if (fresh.data !== shownFee) return session.fail(`The fee changed to ${formatUsdc(fresh.data)} USDC. Check it and submit again.`);
      // Simulate first: a revert here costs nothing and shows a readable reason (through
      // describeContractError below) before the wallet even opens, instead of after the user pays gas.
      const { request } = await client.simulateContract({
        account: address,
        address: contracts.tokenFactory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: [result.args],
        value: fresh.data,
      });
      const hash = await writeContractAsync(request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      // Only trust a TokenCreated log the factory itself emitted — a malicious token contract created in the
      // same transaction could otherwise forge the event.
      const factoryLogs = receipt.logs.filter((l) => l.address.toLowerCase() === contracts.tokenFactory.toLowerCase());
      const [log] = parseEventLogs({ abi: tokenFactoryAbi, logs: factoryLogs, eventName: "TokenCreated" });
      // UserFacingError, not a plain Error: the transaction DID succeed (the user paid), so this
      // message must survive describeContractError's formatting below verbatim rather than being
      // replaced by its generic "didn't go through" fallback, which would wrongly invite a retry
      // (and a second charge) for a mint that actually went through.
      if (!log) throw new UserFacingError("The transaction succeeded but no token was reported.");
      session.finish({ token: log.args.token, symbol: result.args.symbol, decimals: result.args.decimals });
      trackEvent("mint_success", { mintable: Number(result.args.mintable), burnable: Number(result.args.burnable) });
      notify(`${result.args.symbol} created`, "ok");
    } catch (err) {
      session.fail(describeContractError(err));
    }
  };

  if (mintSession.status === "done") {
    if (mintSession.result) {
      const created = mintSession.result;
      return (
        <div className="p-5 text-sm">
          <p className="text-base font-medium">{created.symbol} is live</p>
          <a className="mt-1 block break-all font-mono text-xs text-accent-text" href={explorerUrl("token", created.token)} target="_blank" rel="noreferrer">{created.token}</a>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => open("inspector", { token: created.token })}>Inspect it</button>
            <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => open("drop", { token: created.token, symbol: created.symbol, decimals: String(created.decimals) })}>Send with Drop</button>
            <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => { session.dismiss(); setForm(EMPTY); }}>Create another</button>
          </div>
        </div>
      );
    }
    return (
      <div className="p-5 text-sm">
        <p className="text-accent-3-text">{mintSession.error}</p>
        <button type="button" className="mt-3 rounded-md border border-border-2 px-3 py-1.5" onClick={() => session.dismiss()}>Try again</button>
      </div>
    );
  }

  const field = (key: "name" | "symbol" | "decimals" | "supply" | "cap", label: string, placeholder: string) => (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        className="mt-1 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5"
        value={form[key]}
        placeholder={placeholder}
        disabled={sessionActive}
        onChange={(e) => set(key, e.target.value)}
        aria-invalid={!!errors[key]}
      />
      {errors[key] && <span className="mt-1 block text-xs text-accent-3-text">{errors[key]}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} className="grid gap-3 p-5 text-sm">
      {field("name", "Name", "Duke Token")}
      {field("symbol", "Symbol", "DUKE")}
      <div className="grid grid-cols-2 gap-3">
        {field("supply", "Initial supply", "1,000,000,000")}
        {field("decimals", "Decimals", "18")}
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={form.burnable} disabled={sessionActive} onChange={(e) => set("burnable", e.target.checked)} />
        <span>Holders can burn their tokens</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={form.mintable} disabled={sessionActive} onChange={(e) => set("mintable", e.target.checked)} />
        <span>
          I can mint more later
          <span className="block text-xs text-muted">{'Inspector will show "Owner can mint new supply" until you renounce ownership.'}</span>
        </span>
      </label>
      {form.mintable && field("cap", "Maximum supply (optional)", "Leave empty for no cap")}
      <p className="text-xs text-muted">The supply goes to your wallet. The contract has no fees, no blacklist and no pause.</p>
      {sessionActive && (
        <p className="text-xs text-muted">{`Minting ${mintSession.symbol}… you can close this window — the mint continues.`}</p>
      )}
      <button type="submit" disabled={sessionActive} className="rounded-md border border-border-2 px-3 py-2">
        {sessionActive ? "Waiting for your wallet…" : `Create token · ${fee.data !== undefined ? formatUsdc(fee.data) : "…"} USDC`}
      </button>
    </form>
  );
}

export default function MintWindow() {
  return (
    <ConnectGate>
      <Form />
    </ConnectGate>
  );
}
