import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTODY_POSITION, CUSTODY_TOKEN, NOT_YOURS, TRANSFER_NOTE, UNAUDITED } from "../copy";

/**
 * Vault's words, held to the copy rules: plain sentences, the product named "ArcOS", custody said as it is, the missing
 * audit said on every screen, and none of the words that promise what a contract can't ("safe", "guaranteed", "free",
 * "instant"). The rule is checked on every string in the app's source, comments left out.
 */
const DIR = path.resolve(import.meta.dirname, "..");
const SOURCES = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f));
const PROMISES = /\b(safe(ly|ty)?|guarantee[ds]?|free|instant(ly)?)\b/i;

/** Every string literal in a source file (quotes and backticks), comments stripped first. */
function strings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

describe("Vault's copy", () => {
  it("says what custody means, for a token and for a position", () => {
    expect(CUSTODY_TOKEN).toBe("The tokens sit in a vault contract. Only the vault's owner can take them out, and only after the unlock date.");
    expect(CUSTODY_POSITION).toMatch(/^The position sits in a vault contract\. Only the vault's owner can take it out, and only after the unlock date\./);
  });

  it("says the contracts are not audited yet", () => {
    expect(UNAUDITED).toMatch(/not audited yet/i);
    expect(UNAUDITED).toMatch(/testnet/);
  });

  it("writes whole sentences", () => {
    for (const line of [CUSTODY_TOKEN, CUSTODY_POSITION, UNAUDITED, TRANSFER_NOTE, NOT_YOURS]) expect(line).toMatch(/^[A-Z].*\.$/);
  });

  it("promises nothing a contract can't keep, anywhere in the app's strings", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of SOURCES) {
      for (const s of strings(readFileSync(path.join(DIR, file), "utf8"))) if (PROMISES.test(s)) found.push(`${file}: ${s}`);
    }
    expect(found).toEqual([]);
  });

  it("names the product ArcOS, never its old name", () => {
    for (const file of SOURCES) expect(readFileSync(path.join(DIR, file), "utf8"), file).not.toMatch(/4rc\.OS/);
  });

  it("catches the words it is meant to catch", () => {
    for (const bad of ["Your tokens are safe.", "Guaranteed unlock.", "Free to lock.", "Instant withdrawals.", "Locked safely."]) {
      expect(strings(`const x = "${bad}";`).some((s) => PROMISES.test(s)), bad).toBe(true);
    }
    expect(strings(`// safe\nconst y = "fine";`).some((s) => PROMISES.test(s))).toBe(false);
  });
});
