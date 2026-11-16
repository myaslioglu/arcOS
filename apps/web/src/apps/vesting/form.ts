import { getAddress, isAddress } from "viem";
import { AmountError, parseTokenAmount } from "@arcos/chain";
import { ambiguousBannerText, hasAmbiguousIssue, parseDropList, type DropIssue, type DropRow } from "@/lib/recipient-list";
import { validateAddress, validateAmount, validateTerms, type ScheduleErrors } from "./schedule";
import { parseCliff, parseSpan, parseStart, type SpanUnit } from "./span";

/**
 * What the New schedule form holds, and everything derived from it that doesn't need React: the rows to create, the
 * schedule terms in seconds, and the first thing standing in the way. Pure, so every rule is tested without a window.
 */

/** Rows one run creates at most. Not a contract limit: each row is its own wallet confirmation, and a longer list is easier to run in two. */
export const MAX_BULK_ROWS = 50;

export type FormState = {
  token: string;
  mode: "one" | "many";
  beneficiary: string;
  amount: string;
  list: string;
  startMode: "now" | "date";
  startDate: string;
  durationValue: string;
  durationUnit: SpanUnit;
  cliffValue: string;
  cliffUnit: SpanUnit;
};

export const EMPTY_FORM: FormState = {
  token: "",
  mode: "one",
  beneficiary: "",
  amount: "",
  list: "",
  startMode: "now",
  startDate: "",
  durationValue: "12",
  durationUnit: "weeks",
  cliffValue: "",
  cliffUnit: "weeks",
};

export type Terms = { start: bigint; duration: bigint; cliff: bigint };

export type FormErrors = ScheduleErrors & Partial<Record<"list", string>>;

export type Plan = {
  rows: DropRow[];
  /** Rows of the pasted list the parser left out, with why. Always empty in "one" mode. */
  issues: DropIssue[];
  /** Null while the duration, cliff or start isn't usable. */
  terms: Terms | null;
  errors: FormErrors;
  total: bigint;
  /** A sentence naming the one thing to fix first, or null when the plan can be sent. */
  blocker: string | null;
  ok: boolean;
};

/** An amount typed into the one-schedule form: its value, or why it can't be read. Empty isn't an error until the button is pressed. */
export function readAmount(text: string, decimals: number): { amount: bigint | null; error: string | null } {
  if (text.trim() === "") return { amount: null, error: null };
  try {
    return { amount: parseTokenAmount(text, decimals), error: null };
  } catch (e) {
    return { amount: null, error: e instanceof AmountError ? e.message : "That isn't an amount." };
  }
}

const ORDER = ["token", "beneficiary", "list", "amount", "duration", "cliff", "start"] as const;

/**
 * The plan for a form: `decimals` is the token's (null while it is unknown), `nowSeconds` the current time. The same
 * function serves one beneficiary and a list, so both are held to the same limits as the contract.
 */
export function buildPlan(form: FormState, decimals: number | null, nowSeconds: bigint): Plan {
  const errors: FormErrors = {};
  const tokenError = validateAddress(form.token, "token");
  if (tokenError) errors.token = tokenError;

  const start = parseStart(form.startMode, form.startDate, nowSeconds);
  const duration = parseSpan(form.durationValue, form.durationUnit);
  const cliff = parseCliff(form.cliffValue, form.cliffUnit);
  if (start === null) errors.start = "Choose when the schedule starts.";
  const termErrors = validateTerms({ start: start ?? nowSeconds, duration, cliff, now: nowSeconds });
  for (const key of ["duration", "cliff", "start"] as const) {
    if (termErrors[key] && !errors[key]) errors[key] = termErrors[key];
  }
  const terms: Terms | null = start !== null && duration !== null && cliff !== null && !errors.duration && !errors.cliff && !errors.start ? { start, duration, cliff } : null;

  let rows: DropRow[] = [];
  let issues: DropIssue[] = [];
  let total = 0n;
  let ambiguous = false;

  if (decimals !== null) {
    if (form.mode === "one") {
      const beneficiaryError = validateAddress(form.beneficiary, "beneficiary");
      if (beneficiaryError) errors.beneficiary = beneficiaryError;
      const { amount, error } = readAmount(form.amount, decimals);
      const amountError = error ?? validateAmount(amount);
      if (amountError) errors.amount = amountError;
      if (!beneficiaryError && !amountError && amount !== null && isAddress(form.beneficiary.trim(), { strict: false })) {
        rows = [{ line: 1, address: getAddress(form.beneficiary.trim()), amount }];
        total = amount;
      }
    } else {
      const parsed = parseDropList(form.list, decimals);
      issues = parsed.issues;
      ambiguous = hasAmbiguousIssue(parsed.issues);
      for (const row of parsed.rows) {
        const tooBig = validateAmount(row.amount);
        if (tooBig) issues = [...issues, { line: row.line, message: tooBig }];
        else rows.push(row);
      }
      total = rows.reduce((s, r) => s + r.amount, 0n);
      if (rows.length > MAX_BULK_ROWS) errors.list = `A run creates at most ${MAX_BULK_ROWS} schedules. Split the list in two.`;
      else if (ambiguous) errors.list = ambiguousBannerText(parsed.issues) ?? "Some amounts could be read two ways.";
      else if (rows.length === 0) errors.list = form.list.trim() === "" ? "Add one beneficiary and amount per line." : "No row in the list can be used.";
    }
  }
  if (errors.list && rows.length > 0 && (rows.length > MAX_BULK_ROWS || ambiguous)) rows = [];

  const first = ORDER.map((k) => errors[k]).find((m) => m !== undefined) ?? null;
  const blocker = first ?? (decimals === null && !tokenError ? "Reading the token…" : null);
  return { rows, issues, terms, errors, total, blocker, ok: blocker === null && rows.length > 0 && terms !== null };
}
