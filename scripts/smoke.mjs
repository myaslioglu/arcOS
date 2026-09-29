#!/usr/bin/env node
// Post-deploy smoke checks for the live site. Three read-only GETs, no credentials:
//   /                                  answers 200 (itself, not through a redirect)
//   /api/pulse                         answers 200 with exactly 1,024 gas-used ratios, each a number from 0 to 1
//   /api/approvals?owner=<address>     answers 200 with at least one approval row
// A rollout that has just finished can take a moment (cold instances, the CDN), so the checks repeat, all three each
// round, until one round passes or about two minutes have gone by.
//
//   node scripts/smoke.mjs [--base https://4rcos.com] [--budget-seconds 120] [--interval-seconds 10]
//
// Exit code 0 when a round passed, 1 when none did, 2 for a bad command line.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE = "https://4rcos.com";
/** An address that has approvals on Arc mainnet (Multicall3's, which many tokens have been approved for). */
export const APPROVALS_OWNER = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PULSE_RATIOS = 1024;

const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

function readJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "the answer is not JSON" };
  }
}

/** @returns {{ ok: boolean, detail: string }} */
export function checkHome(status) {
  return status === 200 ? { ok: true, detail: "200" } : { ok: false, detail: `answered ${status}` };
}

export function checkPulse(status, body) {
  if (status !== 200) return { ok: false, detail: `answered ${status}` };
  const { value, error } = readJson(body);
  if (error) return { ok: false, detail: error };
  const ratios = value !== null && typeof value === "object" ? value.ratios : undefined;
  if (!Array.isArray(ratios)) return { ok: false, detail: "the answer has no ratios array" };
  if (ratios.length !== PULSE_RATIOS) return { ok: false, detail: `${ratios.length} ratios, expected ${PULSE_RATIOS}` };
  if (!ratios.every((r) => typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 1)) {
    return { ok: false, detail: "a ratio is not a number from 0 to 1" };
  }
  return { ok: true, detail: `${ratios.length} ratios` };
}

export function checkApprovals(status, body) {
  if (status !== 200) return { ok: false, detail: `answered ${status}` };
  const { value, error } = readJson(body);
  if (error) return { ok: false, detail: error };
  const rows = value !== null && typeof value === "object" ? value.approvals : undefined;
  if (!Array.isArray(rows)) return { ok: false, detail: "the answer has no approvals array" };
  if (rows.length === 0) return { ok: false, detail: "no rows, expected at least one" };
  if (!rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) return { ok: false, detail: "a row is not an object" };
  return { ok: true, detail: `${rows.length} rows` };
}

const CHECKS = [
  { name: "home", path: "/", verify: checkHome },
  { name: "pulse", path: "/api/pulse", verify: checkPulse },
  { name: "approvals", path: `/api/approvals?owner=${APPROVALS_OWNER}`, verify: checkApprovals },
];

async function runCheck(check, { base, fetchImpl, timeoutMs }) {
  try {
    const res = await fetchImpl(`${base}${check.path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "arcos-deploy-smoke", accept: "*/*" },
    });
    const body = await res.text();
    return { name: check.name, ...check.verify(res.status, body) };
  } catch (e) {
    return { name: check.name, ok: false, detail: `request failed (${e instanceof Error ? e.name : "error"})` };
  }
}

/**
 * Runs the checks in rounds until a whole round passes, or the next round could not start inside the budget.
 * @returns {Promise<{ ok: boolean, rounds: number, results: { name: string, ok: boolean, detail: string }[] }>}
 */
export async function runSmoke(options) {
  const {
    base = DEFAULT_BASE,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    budgetMs = DEFAULT_BUDGET_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    log = () => {},
  } = options ?? {};
  const started = now();
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const results = [];
    for (const check of CHECKS) results.push(await runCheck(check, { base, fetchImpl, timeoutMs }));
    log(`round ${rounds}: ${results.map((r) => `${r.name} ${r.ok ? "ok" : "FAIL"} (${r.detail})`).join(", ")}`);
    const ok = results.every((r) => r.ok);
    if (ok || now() - started + intervalMs >= budgetMs) return { ok, rounds, results };
    await sleep(intervalMs);
  }
}

/** The options for runSmoke from the command line; throws on anything it doesn't understand. */
export function parseArgs(argv) {
  const parsed = { base: DEFAULT_BASE, budgetMs: DEFAULT_BUDGET_MS, intervalMs: DEFAULT_INTERVAL_MS };
  const seconds = (name, value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number of seconds`);
    return Math.round(n * 1000);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--base" || arg === "--budget-seconds" || arg === "--interval-seconds") {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg === "--base") {
        let url;
        try {
          url = new URL(value);
        } catch {
          throw new Error("--base needs a URL such as https://4rcos.com");
        }
        if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) throw new Error("--base must be just an http(s) origin");
        parsed.base = url.origin;
      } else if (arg === "--budget-seconds") {
        parsed.budgetMs = seconds(arg, value);
      } else {
        parsed.intervalMs = seconds(arg, value);
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return parsed;
}

/** @param {string[]} argv @param {{ log: (line: string) => void, error: (line: string) => void }} io */
export async function main(argv, io) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    io.error(`usage: ${e.message}`);
    return 2;
  }
  io.log(`smoke: ${options.base}, up to ${Math.round(options.budgetMs / 1000)} s`);
  const { ok, rounds } = await runSmoke({ ...options, log: io.log });
  io.log(ok ? `smoke: ok after ${rounds} ${rounds === 1 ? "round" : "rounds"}` : `smoke: FAILED, no round passed in ${rounds} ${rounds === 1 ? "try" : "tries"}`);
  return ok ? 0 : 1;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = await main(process.argv.slice(2), { log: console.log, error: console.error });
}
