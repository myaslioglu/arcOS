import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockfile, isPermissive, parseVersion } from "./walletconnect-licence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = (packages) => ({ lockfileVersion: 3, packages });
const pkg = (version, license) => ({ version, license });

describe("isPermissive", () => {
  it.each(["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "MIT OR Apache-2.0", "(MIT AND ISC)"])("passes %s", (l) => {
    expect(isPermissive(l)).toBe(true);
  });
  it.each(["SEE LICENSE IN LICENSE.md", "UNLICENSED", "MIT OR BUSL-1.1", "", undefined, null])("fails %s", (l) => {
    expect(isPermissive(l)).toBe(false);
  });
});

describe("parseVersion", () => {
  it("reads a release and a prerelease", () => {
    expect(parseVersion("2.21.8")).toEqual([2, 21, 8]);
    expect(parseVersion("2.21.10-canary-a-0")).toEqual([2, 21, 10]);
  });
  it("gives null for what isn't a version", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe("checkLockfile", () => {
  it("passes the last Apache-2.0 releases and the MIT helpers, at any depth", () => {
    const { found, problems } = checkLockfile(
      lock({
        "": { name: "root" },
        "node_modules/@walletconnect/ethereum-provider": pkg("2.21.8", "Apache-2.0"),
        "node_modules/@reown/appkit/node_modules/@walletconnect/utils": pkg("2.21.0", "Apache-2.0"),
        "node_modules/@walletconnect/logger": pkg("2.1.2", "MIT"),
        "node_modules/@reown/appkit": pkg("1.7.8", "Apache-2.0"),
        "node_modules/viem": pkg("2.56.8", "MIT"),
      }),
    );
    expect(problems).toEqual([]);
    expect(found).toHaveLength(4);
  });

  it("fails the first relicensed releases even when the licence field says Apache-2.0", () => {
    const { problems } = checkLockfile(
      lock({
        "node_modules/@walletconnect/ethereum-provider": pkg("2.21.9", "Apache-2.0"),
        "node_modules/@reown/appkit": pkg("1.8.0", "Apache-2.0"),
      }),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/2\.21\.9/);
    expect(problems[1]).toMatch(/1\.8\.0/);
  });

  it("fails a later release, a nested copy, a prerelease past the line, and a licence that isn't permissive", () => {
    const { problems } = checkLockfile(
      lock({
        "node_modules/@walletconnect/ethereum-provider": pkg("2.25.0", "SEE LICENSE IN LICENSE.md"),
        "apps/web/node_modules/@walletconnect/core": pkg("2.21.10-canary-a-0", "Apache-2.0"),
        "node_modules/@walletconnect/jsonrpc-types": pkg("1.0.5", "SEE LICENSE IN LICENSE.md"),
        "node_modules/@reown/appkit/node_modules/@reown/appkit-ui": pkg("1.8.19", "SEE LICENSE IN LICENSE.md"),
        "node_modules/@reown/appkit-common": pkg("1.7.8", undefined),
      }),
    );
    expect(problems.filter((p) => p.includes("ethereum-provider"))).toHaveLength(2);
    expect(problems.some((p) => p.startsWith("apps/web/node_modules/@walletconnect/core"))).toBe(true);
    expect(problems.some((p) => p.includes("jsonrpc-types") && p.includes("licence"))).toBe(true);
    expect(problems.filter((p) => p.includes("appkit-ui"))).toHaveLength(2);
    expect(problems.some((p) => p.includes("appkit-common") && p.includes("null"))).toBe(true);
  });

  it("refuses something that isn't a lockfile", () => {
    expect(() => checkLockfile({})).toThrow(/packages map/);
  });
});

// The repo's own lockfile: every @walletconnect/* and @reown/* package it resolves stays on the Apache-2.0 / MIT side.
describe("package-lock.json", () => {
  const { found, problems } = checkLockfile(JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")));

  it("holds the WalletConnect provider, so the check below has something to look at", () => {
    expect(found).toContain("@walletconnect/ethereum-provider@2.21.8");
  });

  it("has no WalletConnect or Reown package past the Apache-2.0 line", () => {
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("pins the provider to one exact version in apps/web, so a range can't float past the line on a fresh install", () => {
    const web = JSON.parse(fs.readFileSync(path.join(root, "apps/web/package.json"), "utf8"));
    expect(web.dependencies["@walletconnect/ethereum-provider"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
