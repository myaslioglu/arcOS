"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { parseEventLogs } from "viem";
import { ARCOS, FEE_KEYS, activeChain, activeNetwork, explorerUrl, feeControllerAbi, formatUsdc, tokenFactoryAbi } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
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
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; symbol: string } | null>(null);

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
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: contracts.tokenFactory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: [result.args],
        value: fee.data,
        chainId: chain.id,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      const [log] = parseEventLogs({ abi: tokenFactoryAbi, logs: receipt.logs, eventName: "TokenCreated" });
      if (!log) throw new Error("The transaction succeeded but no token was reported.");
      setCreated({ token: log.args.token, symbol: result.args.symbol });
      trackEvent("mint_success", { mintable: Number(result.args.mintable), burnable: Number(result.args.burnable) });
      notify(`${result.args.symbol} created`, "ok");
    } catch (err) {
      notify((err as { shortMessage?: string }).shortMessage ?? "The transaction didn't go through.", "warn", 6000);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="p-5 text-sm">
        <p className="text-base font-medium">{created.symbol} is live</p>
        <a className="mt-1 block break-all font-mono text-xs text-accent-text" href={explorerUrl("token", created.token)} target="_blank" rel="noreferrer">{created.token}</a>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => open("inspector", { token: created.token })}>Inspect it</button>
          <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => open("drop", { token: created.token, symbol: created.symbol, decimals: form.decimals })}>Send with Drop</button>
          <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={() => { setCreated(null); setForm(EMPTY); }}>Create another</button>
        </div>
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
        <input type="checkbox" className="mt-1" checked={form.burnable} onChange={(e) => set("burnable", e.target.checked)} />
        <span>Holders can burn their tokens</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={form.mintable} onChange={(e) => set("mintable", e.target.checked)} />
        <span>
          I can mint more later
          <span className="block text-xs text-muted">{'Inspector will show "Owner can mint new supply" until you renounce ownership.'}</span>
        </span>
      </label>
      {form.mintable && field("cap", "Maximum supply (optional)", "Leave empty for no cap")}
      <p className="text-xs text-muted">The supply goes to your wallet. The contract has no fees, no blacklist and no pause.</p>
      <button type="submit" disabled={busy} className="rounded-md border border-border-2 px-3 py-2">
        {busy ? "Waiting for your wallet…" : `Create token · ${fee.data !== undefined ? formatUsdc(fee.data) : "…"} USDC`}
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
