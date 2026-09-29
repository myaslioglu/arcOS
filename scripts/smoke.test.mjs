import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVALS_OWNER, PULSE_RATIOS, checkApprovals, checkHome, checkPulse, parseArgs, runSmoke } from "./smoke.mjs";

const fixture = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("checkHome", () => {
  it("wants a 200", () => {
    expect(checkHome(200, "<html></html>").ok).toBe(true);
  });
  it.each([301, 308, 404, 500, 503])("fails on %i", (status) => {
    expect(checkHome(status, "").ok).toBe(false);
  });
});

describe("checkPulse", () => {
  it("passes 1,024 ratios", () => {
    expect(checkPulse(200, fixture("pulse-ok.json"))).toEqual({ ok: true, detail: "1024 ratios" });
    expect(PULSE_RATIOS).toBe(1024);
  });

  it("fails on 1,023 ratios, naming the count", () => {
    const r = checkPulse(200, fixture("pulse-short.json"));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/1023 ratios, expected 1024/);
  });

  it("fails on 1,025 ratios", () => {
    const body = JSON.stringify({ oldestBlock: 1, ratios: Array(1025).fill(0.5) });
    expect(checkPulse(200, body).ok).toBe(false);
  });

  it("fails on the route's own error answer", () => {
    expect(checkPulse(503, fixture("unavailable.json"))).toMatchObject({ ok: false, detail: "answered 503" });
  });

  it.each([
    ["not JSON", "<html>bad gateway</html>"],
    ["JSON with no ratios", JSON.stringify({ oldestBlock: 1 })],
    ["ratios that are not an array", JSON.stringify({ ratios: "1024" })],
    ["a string among the ratios", JSON.stringify({ ratios: [...Array(1023).fill(0.1), "0.1"] })],
    ["a null among the ratios", JSON.stringify({ ratios: [...Array(1023).fill(0.1), null] })],
    ["a ratio above 1", JSON.stringify({ ratios: [...Array(1023).fill(0.1), 1.5] })],
    ["a negative ratio", JSON.stringify({ ratios: [...Array(1023).fill(0.1), -0.1] })],
    ["a top-level array", JSON.stringify(Array(1024).fill(0.1))],
  ])("fails on %s", (_name, body) => {
    expect(checkPulse(200, body).ok).toBe(false);
  });
});

describe("checkApprovals", () => {
  it("passes when there is at least one row", () => {
    expect(checkApprovals(200, fixture("approvals-ok.json"))).toEqual({ ok: true, detail: "2 rows" });
  });

  it("passes on a single row", () => {
    expect(checkApprovals(200, JSON.stringify({ approvals: [{ token: "0x1" }], truncated: true })).ok).toBe(true);
  });

  it("fails on no rows", () => {
    const r = checkApprovals(200, fixture("approvals-empty.json"));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no rows/);
  });

  it.each([400, 429, 503])("fails on a %i", (status) => {
    expect(checkApprovals(status, fixture("unavailable.json")).ok).toBe(false);
  });

  it.each([
    ["not JSON", "oops"],
    ["no approvals key", JSON.stringify({ truncated: false })],
    ["approvals that is not an array", JSON.stringify({ approvals: {} })],
    ["rows that are not objects", JSON.stringify({ approvals: [null] })],
    ["rows that are strings", JSON.stringify({ approvals: ["0x1"] })],
  ])("fails on %s", (_name, body) => {
    expect(checkApprovals(200, body).ok).toBe(false);
  });
});

describe("parseArgs", () => {
  it("defaults to the live site and a two-minute budget", () => {
    expect(parseArgs([])).toEqual({ base: "https://4rcos.com", budgetMs: 120_000, intervalMs: 10_000 });
  });
  it("takes a base URL, dropping a trailing slash, and the two timings in seconds", () => {
    expect(parseArgs(["--base", "http://127.0.0.1:3000/", "--budget-seconds", "30", "--interval-seconds", "2"])).toEqual({
      base: "http://127.0.0.1:3000",
      budgetMs: 30_000,
      intervalMs: 2_000,
    });
  });
  it.each([["--nope"], ["--base"], ["--base", "not a url"], ["--budget-seconds", "0"], ["--interval-seconds", "x"], ["stray"]])("rejects %j", (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
});

/**
 * A fake fetch: `plan` maps a URL's path (with its query) to the responses to give, in order; the last repeats.
 * Returns the fake and the list of [url, init] it was called with.
 */
function fakeFetch(plan) {
  const calls = [];
  const used = new Map();
  const impl = async (url, init) => {
    calls.push([url, init]);
    const key = new URL(url).pathname + new URL(url).search;
    const list = plan[key];
    if (!list) throw new Error(`unplanned request ${key}`);
    const i = Math.min(used.get(key) ?? 0, list.length - 1);
    used.set(key, (used.get(key) ?? 0) + 1);
    const step = list[i];
    if (step instanceof Error) throw step;
    return { status: step.status, text: async () => step.body ?? "" };
  };
  return { impl, calls };
}

function clock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const HOME = "/";
const PULSE = "/api/pulse";
const APPROVALS = `/api/approvals?owner=${APPROVALS_OWNER}`;
const good = {
  [HOME]: [{ status: 200, body: "<html>ok</html>" }],
  [PULSE]: [{ status: 200, body: fixture("pulse-ok.json") }],
  [APPROVALS]: [{ status: 200, body: fixture("approvals-ok.json") }],
};

describe("runSmoke", () => {
  const options = (extra) => ({ base: "https://site.test", budgetMs: 100_000, intervalMs: 30_000, log: () => {}, ...extra });

  it("passes on the first round without waiting when everything answers", async () => {
    const f = fakeFetch(good);
    const c = clock();
    const result = await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now }));
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(1);
    expect(c.sleeps).toEqual([]);
    expect(f.calls.map(([u]) => u)).toEqual([`https://site.test${HOME}`, `https://site.test${PULSE}`, `https://site.test${APPROVALS}`]);
  });

  it("asks for the approvals of the fixed owner, and never follows a redirect, and gives every request a timeout", async () => {
    const f = fakeFetch(good);
    const c = clock();
    await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now }));
    expect(APPROVALS_OWNER).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    for (const [, init] of f.calls) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("retries a fresh rollout's 503s and passes once the site is up", async () => {
    const f = fakeFetch({ ...good, [PULSE]: [{ status: 503, body: fixture("unavailable.json") }, { status: 503 }, { status: 200, body: fixture("pulse-ok.json") }] });
    const c = clock();
    const lines = [];
    const result = await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now, log: (l) => lines.push(l) }));
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(3);
    expect(c.sleeps).toEqual([30_000, 30_000]);
    expect(lines.some((l) => l.includes("pulse FAIL"))).toBe(true);
  });

  it("gives up once the budget would be spent, reporting the last round", async () => {
    const f = fakeFetch({ ...good, [APPROVALS]: [{ status: 200, body: fixture("approvals-empty.json") }] });
    const c = clock();
    const result = await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now }));
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(4); // t = 0, 30, 60, 90 s; a fifth would start at 120 s, past the 100 s budget
    expect(c.sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(result.results.find((r) => r.name === "approvals").ok).toBe(false);
    expect(result.results.find((r) => r.name === "home").ok).toBe(true);
  });

  it("counts a network error or timeout as a failed check, not a crash", async () => {
    const f = fakeFetch({ ...good, [HOME]: [new TypeError("fetch failed")] });
    const c = clock();
    const result = await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now, budgetMs: 10_000 }));
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ name: "home", ok: false });
    expect(result.results[0].detail).toMatch(/request failed \(TypeError\)/);
  });

  it("fails the home page on a redirect, since the URL asked for must answer 200 itself", async () => {
    const f = fakeFetch({ ...good, [HOME]: [{ status: 301 }] });
    const c = clock();
    const result = await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now, budgetMs: 10_000 }));
    expect(result.ok).toBe(false);
    expect(result.results[0].detail).toBe("answered 301");
  });

  it("does not sleep after the last round", async () => {
    const f = fakeFetch({ ...good, [PULSE]: [{ status: 500 }] });
    const c = clock();
    await runSmoke(options({ fetchImpl: f.impl, sleep: c.sleep, now: c.now, budgetMs: 25_000 }));
    expect(c.sleeps).toEqual([]); // 0 + 30 s already passes the 25 s budget
  });
});
