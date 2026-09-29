import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A source scan: the Revoke window can't be driven here (it needs a wallet and a chain), so this pins where the count is
 * made. A revoke counts once it is confirmed and the allowance reads zero. It doesn't count when the list showed an approval
 * that was already zero (no transaction was sent), when the receipt is a revert, or when the allowance is still set.
 */
describe("Window.tsx counts a revoke only when it is confirmed and the allowance reads zero", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("makes exactly one trackEvent call in the file, with no props", () => {
    expect([...source.matchAll(/\btrackEvent\(/g)]).toHaveLength(1);
    expect(source).toContain('trackEvent("revoke_success");');
  });

  it("makes it in the branch that follows the receipt, where the allowance reads zero", () => {
    const confirmed = source.indexOf("stage = \"confirmed\"");
    const zero = source.indexOf("if (now === 0n) {");
    const stillSet = source.indexOf("ALLOWANCE_STILL_SET", zero);
    const call = source.indexOf('trackEvent("revoke_success");');
    expect(confirmed, "the confirmed stage").toBeGreaterThan(-1);
    expect(zero, "the zero branch").toBeGreaterThan(confirmed);
    expect(call, "the call").toBeGreaterThan(zero);
    expect(call, "before the branch where the allowance is still set").toBeLessThan(stillSet);
    // The same branch marks the pair revoked.
    expect(source.slice(zero, source.indexOf("} else {", zero))).toMatch(/markRevoked\(owner, row, Number\(receipt\.blockNumber\)\);/);
  });

  it("doesn't make it before a transaction was sent: not in the shortcut for an approval that is already zero", () => {
    const shortcut = source.indexOf("liveAllowance === 0n");
    // withChain( marks where the wallet is asked to sign. The name of the wagmi call itself is left out of this file, since
    // paid-write.test.ts scans every file that spells it for a call that isn't wrapped.
    const write = source.indexOf("withChain(request, chain.id)");
    expect(shortcut).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(shortcut);
    expect(source.slice(shortcut, write)).not.toContain("trackEvent(");
  });

  it("doesn't make it for a revert, which throws before the allowance is read again", () => {
    const revert = source.indexOf('receipt.status === "reverted"');
    const zero = source.indexOf("if (now === 0n) {");
    expect(revert).toBeGreaterThan(-1);
    expect(source.slice(revert, zero)).not.toContain("trackEvent(");
  });
});
