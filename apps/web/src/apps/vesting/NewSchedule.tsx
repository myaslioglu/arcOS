"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits, isAddress } from "viem";
import { USDC, activeChain, type Address } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { useDesktop } from "@arcos/shell";
import { describeContractError } from "@/lib/contract-error";
import { displayAmount } from "@/lib/display-amount";
import { shortAddress } from "@/lib/format";
import { HOW_IT_WORKS } from "./copy";
import { Curve } from "./Curve";
import { EMPTY_FORM, MAX_BULK_ROWS, buildPlan, type FormState } from "./form";
import { vestFeeText, vestFeeTotal } from "./fee";
import { RunPanel } from "./RunPanel";
import { startedNote } from "./schedule";
import { session } from "./session";
import { SPAN_UNITS, spanText, utcText } from "./span";
import { useCreateVestings } from "./useCreate";
import { rowsText } from "./form-text";

const MAX_FILE_BYTES = 2_000_000;

const INPUT = "min-w-0 rounded-md border border-border-2 bg-surface px-2 py-1.5 text-xs disabled:opacity-50";
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";
const LABEL = "block text-xs text-muted";

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

function UnitSelect({ value, onChange, label, disabled }: { value: FormState["durationUnit"]; onChange: (v: FormState["durationUnit"]) => void; label: string; disabled: boolean }) {
  return (
    <select aria-label={label} className={INPUT} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as FormState["durationUnit"])}>
      {SPAN_UNITS.map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}

/** The New schedule tab: one beneficiary or a list, the terms, a preview of the release, the fee, and the run. */
export function NewSchedule({ prefilledToken }: { prefilledToken: Address | null }) {
  const chain = activeChain();
  const { open, notify } = useDesktop();
  const { address } = useConnection();
  const { ready, readFee, run } = useCreateVestings();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM, token: prefilledToken ?? "" });
  const [fileName, setFileName] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // A token handed to an open window (a drop, a link) replaces the field once per new token.
  const [syncedToken, setSyncedToken] = useState(prefilledToken);
  if (prefilledToken !== syncedToken) {
    setSyncedToken(prefilledToken);
    if (prefilledToken) set("token", prefilledToken);
  }

  const tokenCandidate = isAddress(form.token.trim(), { strict: false }) ? (form.token.trim() as Address) : null;
  const meta = useReadContracts({
    contracts: tokenCandidate
      ? [
          { address: tokenCandidate, abi: erc20Abi, functionName: "symbol", chainId: chain.id } as const,
          { address: tokenCandidate, abi: erc20Abi, functionName: "decimals", chainId: chain.id } as const,
        ]
      : [],
    query: { enabled: !!tokenCandidate },
  });
  const decimalsFailed = tokenCandidate ? meta.status === "error" || meta.data?.[1]?.status === "failure" : false;
  const decimals = tokenCandidate ? ((meta.data?.[1]?.result as number | undefined) ?? null) : null;
  const symbol = tokenCandidate
    ? meta.data?.[0]?.status === "success"
      ? (cleanLabel(meta.data[0].result as string, 32) ?? shortAddress(tokenCandidate))
      : meta.data
        ? shortAddress(tokenCandidate)
        : null
    : null;

  const balance = useReadContract({
    address: tokenCandidate ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: !!tokenCandidate && !!address },
  });

  const fee = useQuery({ queryKey: ["vesting-fee", chain.id], queryFn: readFee, enabled: ready, staleTime: 30_000 });
  const feeValue: bigint | "error" | null = fee.isError ? "error" : (fee.data ?? null);

  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), 30_000);
    return () => clearInterval(id);
  }, []);

  const plan = useMemo(() => buildPlan(form, decimals !== null && symbol !== null ? decimals : null, now), [form, decimals, symbol, now]);
  const busy = snapshot.status === "running";

  const readFile = (file: File | undefined) => {
    if (busy || !file) return;
    if (file.size > MAX_FILE_BYTES) return notify("That file is over 2 MB.", "warn");
    setFileName(file.name);
    void file.text().then((text) => set("list", text));
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    readFile(f);
  };

  if (snapshot.status !== "idle") {
    return (
      <RunPanel
        run={snapshot}
        onDone={() => session.dismiss()}
        onReuse={(rows) => {
          set("mode", "many");
          set("list", rowsText(rows, snapshot.decimals));
          set("token", snapshot.token);
          session.dismiss();
        }}
        onOpenRevoke={() => open("revoke")}
      />
    );
  }

  const submit = () => {
    if (!plan.ok || !plan.terms || decimals === null || symbol === null || !tokenCandidate) return;
    if (typeof feeValue !== "bigint") return notify("Couldn't read the fee. Try again.", "warn");
    // "Now" is read again here, at the moment of signing, not taken from the render.
    const fresh = buildPlan(form, decimals, nowSeconds());
    if (!fresh.ok || !fresh.terms) return;
    void run(tokenCandidate, symbol, decimals, fresh.rows, fresh.terms, feeValue).catch((err: unknown) => notify(describeContractError(err), "warn", 6000));
  };

  const show = (key: keyof typeof plan.errors, value: string) => (value.trim() !== "" ? plan.errors[key] : undefined);
  const durationError = plan.errors.duration;
  const cliffError = plan.errors.cliff;
  const terms = plan.terms;
  const total = plan.total;
  const totalShort = decimals === null ? "" : displayAmount(formatUnits(total, decimals), { mode: "up" });
  const have = balance.data;
  const short = have !== undefined && decimals !== null && total > have;
  const note = terms ? startedNote(terms.start, terms.duration, terms.cliff, now) : null;
  const rowCount = plan.rows.length;
  const feeText = vestFeeText(feeValue, rowCount);
  const feeTotal = typeof feeValue === "bigint" ? vestFeeTotal(feeValue, rowCount) : null;

  return (
    <div className="p-3 text-sm">
      <p className="text-xs text-muted">{HOW_IT_WORKS}</p>

      <label className={`${LABEL} mt-3`} htmlFor="vesting-token">
        Token
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="vesting-token"
          className={`${INPUT} flex-1 font-mono`}
          placeholder="Token contract address"
          value={form.token}
          onChange={(e) => set("token", e.target.value)}
          aria-invalid={show("token", form.token) ? true : undefined}
        />
        <button type="button" className={BUTTON} onClick={() => set("token", USDC)}>
          USDC
        </button>
      </div>
      {show("token", form.token) && <p className="mt-1 text-xs text-accent-3-text">{plan.errors.token}</p>}
      {tokenCandidate && decimalsFailed && <p className="mt-1 text-xs text-accent-3-text">{"Couldn't read this token. Check the address."}</p>}
      {tokenCandidate && !decimalsFailed && decimals === null && <p className="mt-1 text-xs text-muted">Reading the token…</p>}
      {symbol !== null && decimals !== null && (
        <p className="mt-1 text-xs text-muted">
          {symbol} · {balance.data !== undefined ? `your balance ${displayAmount(formatUnits(balance.data, decimals), { mode: "down" })}` : "reading your balance…"} ·{" "}
          <a className="text-accent-text" href={`/t/${tokenCandidate}`} target="_blank" rel="noreferrer">
            Token proof page
          </a>
        </p>
      )}

      <div className="mt-4 inline-flex rounded-md border border-border-2 p-0.5 text-xs">
        <button type="button" aria-pressed={form.mode === "one"} className={`rounded px-2 py-1 ${form.mode === "one" ? "bg-surface-2" : ""}`} onClick={() => set("mode", "one")}>
          One beneficiary
        </button>
        <button type="button" aria-pressed={form.mode === "many"} className={`rounded px-2 py-1 ${form.mode === "many" ? "bg-surface-2" : ""}`} onClick={() => set("mode", "many")}>
          A list
        </button>
      </div>

      {form.mode === "one" ? (
        <div className="mt-3 grid gap-3">
          <div>
            <label className={LABEL} htmlFor="vesting-beneficiary">
              Beneficiary
            </label>
            <input
              id="vesting-beneficiary"
              className={`${INPUT} mt-1 w-full font-mono`}
              placeholder="0x…"
              value={form.beneficiary}
              onChange={(e) => set("beneficiary", e.target.value)}
            />
            {show("beneficiary", form.beneficiary) && <p className="mt-1 text-xs text-accent-3-text">{plan.errors.beneficiary}</p>}
          </div>
          <div>
            <label className={LABEL} htmlFor="vesting-amount">
              Amount
            </label>
            <input id="vesting-amount" className={`${INPUT} mt-1 w-full`} inputMode="decimal" placeholder="1000" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
            {show("amount", form.amount) && <p className="mt-1 text-xs text-accent-3-text">{plan.errors.amount}</p>}
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <label className={LABEL} htmlFor="vesting-list">
            One beneficiary and amount per line
          </label>
          <textarea
            id="vesting-list"
            className="mt-1 h-28 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
            placeholder={"0x… , 12.5"}
            value={form.list}
            onChange={(e) => set("list", e.target.value)}
          />
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted">
            <label className={`${BUTTON} inline-flex shrink-0 cursor-pointer items-center text-fg focus-within:outline focus-within:outline-1 focus-within:outline-accent`}>
              Choose CSV
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={onFile} />
            </label>
            <span className="min-w-0 truncate" aria-live="polite">
              {fileName ?? "No file chosen"}
            </span>
          </div>
          {plan.errors.list && form.list.trim() !== "" && <p className="mt-2 text-xs text-accent-3-text">{plan.errors.list}</p>}
          {plan.issues.length > 0 && (
            <ul className="mt-2 max-h-24 overflow-auto text-xs text-accent-3-text">
              {plan.issues.slice(0, 20).map((i) => (
                <li key={`${i.line}-${i.message}`}>
                  Line {i.line}: {i.message}
                </li>
              ))}
              {plan.issues.length > 20 && <li>and {plan.issues.length - 20} more</li>}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted">{`Each row becomes its own schedule with the same terms, up to ${MAX_BULK_ROWS} in a run.`}</p>
        </div>
      )}

      <fieldset className="mt-4 grid gap-3">
        <legend className={LABEL}>Schedule</legend>
        <div>
          <span className={LABEL}>Starts</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-border-2 p-0.5 text-xs">
              <button type="button" aria-pressed={form.startMode === "now"} className={`rounded px-2 py-1 ${form.startMode === "now" ? "bg-surface-2" : ""}`} onClick={() => set("startMode", "now")}>
                When created
              </button>
              <button type="button" aria-pressed={form.startMode === "date"} className={`rounded px-2 py-1 ${form.startMode === "date" ? "bg-surface-2" : ""}`} onClick={() => set("startMode", "date")}>
                On a date
              </button>
            </div>
            {form.startMode === "date" && (
              <input aria-label="Start date and time" type="datetime-local" className={INPUT} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
            )}
          </div>
          {form.startMode === "date" && <p className="mt-1 text-xs text-muted">Your local time. A date in the past is allowed: what has unlocked by now can be released at once.</p>}
          {plan.errors.start && (form.startMode === "date" ? form.startDate !== "" : true) && <p className="mt-1 text-xs text-accent-3-text">{plan.errors.start}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor="vesting-duration">
              Runs for
            </label>
            <div className="mt-1 flex gap-1">
              <input id="vesting-duration" className={`${INPUT} w-16`} inputMode="numeric" value={form.durationValue} onChange={(e) => set("durationValue", e.target.value)} />
              <UnitSelect label="Duration unit" value={form.durationUnit} disabled={false} onChange={(v) => set("durationUnit", v)} />
            </div>
            {durationError && <p className="mt-1 text-xs text-accent-3-text">{durationError}</p>}
          </div>
          <div>
            <label className={LABEL} htmlFor="vesting-cliff">
              Cliff (optional)
            </label>
            <div className="mt-1 flex gap-1">
              <input id="vesting-cliff" className={`${INPUT} w-16`} inputMode="numeric" placeholder="0" value={form.cliffValue} onChange={(e) => set("cliffValue", e.target.value)} />
              <UnitSelect label="Cliff unit" value={form.cliffUnit} disabled={false} onChange={(v) => set("cliffUnit", v)} />
            </div>
            {cliffError && <p className="mt-1 text-xs text-accent-3-text">{cliffError}</p>}
          </div>
        </div>
      </fieldset>

      {terms && (
        <div className="mt-4 rounded-md border border-border-2 p-2">
          <Curve
            start={terms.start}
            duration={terms.duration}
            cliff={terms.cliff}
            label={`Release curve. ${terms.cliff > 0n ? `Nothing unlocks for ${spanText(terms.cliff)}, then ` : ""}tokens unlock evenly until ${utcText(terms.start + terms.duration)}.`}
          />
          <p className="mt-1 text-xs text-muted">
            {terms.cliff > 0n ? `Nothing unlocks until ${utcText(terms.start + terms.cliff)}. ` : ""}
            Everything has unlocked by {utcText(terms.start + terms.duration)}. Unlocking is by the second, rounded down.
          </p>
          {note && <p className="mt-1 text-xs text-accent-3-text">{note}</p>}
        </div>
      )}

      {rowCount > 0 && decimals !== null && symbol !== null && (
        <div className="mt-4 text-xs">
          <p className="text-sm" title={`Total ${formatUnits(total, decimals)} ${symbol}`}>
            {rowCount} {rowCount === 1 ? "schedule" : "schedules"} · total {totalShort} {symbol}
          </p>
          <p className="mt-1 text-muted">
            {`Your wallet first asks you to approve exactly ${totalShort} ${symbol} for the vesting contract (skipped when it already covers that), then to confirm each schedule.`}
          </p>
          {short && <p className="mt-1 text-accent-3-text">{"Your balance is below this total. Schedules your balance can't cover will fail."}</p>}
          {feeValue === "error" ? (
            <p className="mt-1 text-accent-3-text">
              {"Couldn't read the fee. "}
              <button type="button" className="underline" onClick={() => void fee.refetch()}>
                Retry
              </button>
            </p>
          ) : (
            feeText && (
              <p className="mt-1 text-muted" title={feeTotal !== null ? `Fee ${formatUnits(feeTotal, 18)} USDC` : undefined}>
                {feeText}
              </p>
            )
          )}
        </div>
      )}

      <div className="mt-4">
        <button type="button" disabled={!plan.ok || typeof feeValue !== "bigint" || !ready} className="w-full rounded-md border border-border-2 px-3 py-2 disabled:opacity-50" onClick={submit}>
          {rowCount > 1 ? `Create ${rowCount} schedules` : "Create schedule"}
        </button>
        {!plan.ok && plan.blocker && (form.token.trim() !== "" || form.mode === "many") && <p className="mt-1 text-xs text-muted">{plan.blocker}</p>}
      </div>
    </div>
  );
}
