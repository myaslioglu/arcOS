import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeEnv, mergeEnv, parseEnv, render, run } from "./apphosting-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const realFile = path.join(here, "..", "apps", "web", "apphosting.yaml");
const realTestnetFile = path.join(here, "..", "apps", "web", "apphosting.testnet.yaml");

describe("the real apps/web/apphosting.yaml", () => {
  const pairs = buildTimeEnv(parseEnv(fs.readFileSync(realFile, "utf8")));
  const env = Object.fromEntries(pairs);

  it("builds the mainnet bundle", () => {
    expect(env.NEXT_PUBLIC_ARC_NETWORK).toBe("mainnet");
  });

  it("gives the build only public NEXT_PUBLIC_ values, none empty", () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const [name, value] of pairs) {
      expect(name).toMatch(/^NEXT_PUBLIC_[A-Z0-9_]+$/);
      expect(value).not.toBe("");
    }
  });

  it("leaves out the runtime-only secrets", () => {
    expect(env).not.toHaveProperty("BLOCKSCOUT_API_KEY");
    expect(env).not.toHaveProperty("ARCOS_SESSION_SECRET");
    expect(env).not.toHaveProperty("TELEGRAM_WEBHOOK_SECRET");
  });

  it("keeps the Telegram settings out of the build: the webhook secret is a pinned secret, the username a runtime value", () => {
    const entries = parseEnv(fs.readFileSync(realFile, "utf8"));
    expect(entries.find((e) => e.variable === "TELEGRAM_WEBHOOK_SECRET")).toMatchObject({ secret: "TELEGRAM_WEBHOOK_SECRET@1", availability: ["RUNTIME"] });
    const username = entries.find((e) => e.variable === "TELEGRAM_BOT_USERNAME");
    expect(username).toMatchObject({ availability: ["RUNTIME"] });
    expect(username.secret).toBeUndefined();
    expect(env).not.toHaveProperty("TELEGRAM_BOT_USERNAME");
  });
});

// The testnet backend's environment name is `testnet`, so App Hosting builds it with apphosting.testnet.yaml merged over
// apphosting.yaml. These read the two real files merged the same way.
describe("the real apps/web/apphosting.testnet.yaml, merged over apphosting.yaml", () => {
  const merged = mergeEnv(parseEnv(fs.readFileSync(realFile, "utf8")), parseEnv(fs.readFileSync(realTestnetFile, "utf8")));
  const env = Object.fromEntries(buildTimeEnv(merged));

  it("builds the testnet bundle for https://testnet.4rcos.com", () => {
    expect(env.NEXT_PUBLIC_ARC_NETWORK).toBe("testnet");
    expect(env.NEXT_PUBLIC_SITE_URL).toBe("https://testnet.4rcos.com");
  });

  it("charges no platform fee: the fee recipient is not an address", () => {
    expect(env.NEXT_PUBLIC_FEE_RECIPIENT).toBe("none");
  });

  it("keeps the base file's public WalletConnect project ID", () => {
    const base = Object.fromEntries(buildTimeEnv(parseEnv(fs.readFileSync(realFile, "utf8"))));
    expect(env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).toBe(base.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
  });

  // A secret the merged file still names would need the testnet backend's account to have access to it. It has none.
  it("names no secret, so the testnet backend needs access to none", () => {
    expect(merged.filter((e) => e.secret !== undefined)).toEqual([]);
    const key = merged.find((e) => e.variable === "BLOCKSCOUT_API_KEY");
    expect(key).toMatchObject({ value: "none", availability: ["RUNTIME"] });
    // Without the session secret, the testnet site has no sign-in key and sign-in answers 503 there.
    const session = merged.find((e) => e.variable === "ARCOS_SESSION_SECRET");
    expect(session).toMatchObject({ value: "none", availability: ["RUNTIME"] });
    // Without the webhook secret and a bot username, the testnet site's Telegram routes answer 503.
    const webhook = merged.find((e) => e.variable === "TELEGRAM_WEBHOOK_SECRET");
    expect(webhook).toMatchObject({ value: "none", availability: ["RUNTIME"] });
    expect(webhook.secret).toBeUndefined();
    const username = merged.find((e) => e.variable === "TELEGRAM_BOT_USERNAME");
    expect(username).toMatchObject({ value: "none", availability: ["RUNTIME"] });
  });

  it("changes only what differs from mainnet: every other value is the base file's", () => {
    const testnet = parseEnv(fs.readFileSync(realTestnetFile, "utf8")).map((e) => e.variable).sort();
    expect(testnet).toEqual([
      "ARCOS_SESSION_SECRET",
      "BLOCKSCOUT_API_KEY",
      "NEXT_PUBLIC_ARC_NETWORK",
      "NEXT_PUBLIC_FEE_RECIPIENT",
      "NEXT_PUBLIC_SITE_URL",
      "TELEGRAM_BOT_USERNAME",
      "TELEGRAM_WEBHOOK_SECRET",
    ]);
  });
});

describe("mergeEnv", () => {
  const base = parseEnv(
    [
      "env:",
      "  - variable: NEXT_PUBLIC_A",
      "    value: a",
      "    availability: [BUILD, RUNTIME]",
      "  - variable: NEXT_PUBLIC_B",
      "    value: b",
      "  - variable: KEY",
      "    secret: KEY@1",
      "    availability: [RUNTIME]",
      "",
    ].join("\n"),
  );

  it("replaces a base item whole by the environment's item of the same name, as App Hosting does", () => {
    const merged = mergeEnv(base, parseEnv("env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    availability: [RUNTIME]\n"));
    const a = merged.find((e) => e.variable === "NEXT_PUBLIC_A");
    expect(a).toMatchObject({ value: "x", availability: ["RUNTIME"] }); // the base availability is not kept
    expect(buildTimeEnv(merged)).toEqual([["NEXT_PUBLIC_B", "b"]]);
  });

  it("keeps base items the environment doesn't name, and adds the ones only it names", () => {
    const merged = mergeEnv(base, parseEnv("env:\n  - variable: NEXT_PUBLIC_C\n    value: c\n"));
    expect(merged.map((e) => e.variable).sort()).toEqual(["KEY", "NEXT_PUBLIC_A", "NEXT_PUBLIC_B", "NEXT_PUBLIC_C"]);
  });

  it("can turn a base secret into a plain value, so the environment needs no access to it", () => {
    const merged = mergeEnv(base, parseEnv("env:\n  - variable: KEY\n    value: none\n    availability: [RUNTIME]\n"));
    expect(merged.find((e) => e.variable === "KEY")).toMatchObject({ value: "none" });
    expect(merged.find((e) => e.variable === "KEY")?.secret).toBeUndefined();
  });

  it("leaves the base alone when the environment has no env block", () => {
    expect(mergeEnv(base, parseEnv("runConfig:\n  maxInstances: 1\n"))).toEqual(base);
  });
});

describe("parseEnv", () => {
  it("reads plain, double-quoted and single-quoted values, comments, and block or flow availability", () => {
    const entries = parseEnv(
      [
        "# a comment",
        "runConfig:",
        "  minInstances: 0",
        "",
        "env:",
        "  # another comment",
        "  - variable: NEXT_PUBLIC_A",
        "    value: mainnet   # trailing comment",
        "    availability:",
        "      - BUILD",
        "      - RUNTIME",
        "  - variable: NEXT_PUBLIC_B",
        '    value: "https://example.org/a#b"',
        "    availability: [BUILD]",
        "  - variable: NEXT_PUBLIC_C",
        "    value: 'it''s'",
        "  - variable: SOME_SECRET",
        "    secret: SOME_SECRET@1",
        "    availability:",
        "      - RUNTIME",
        "",
      ].join("\n"),
    );
    expect(entries.map((e) => e.variable)).toEqual(["NEXT_PUBLIC_A", "NEXT_PUBLIC_B", "NEXT_PUBLIC_C", "SOME_SECRET"]);
    expect(entries[0]).toMatchObject({ value: "mainnet", availability: ["BUILD", "RUNTIME"] });
    expect(entries[1]).toMatchObject({ value: "https://example.org/a#b", availability: ["BUILD"] });
    expect(entries[2]).toMatchObject({ value: "it's" });
    expect(entries[2].availability).toBeUndefined();
    expect(entries[3]).toMatchObject({ secret: "SOME_SECRET@1", availability: ["RUNTIME"] });
  });

  it("has no entries when there is no env block", () => {
    expect(parseEnv("runConfig:\n  minInstances: 0\n")).toEqual([]);
    expect(parseEnv("")).toEqual([]);
  });

  it.each([
    ["an unknown key", "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    surprise: 1\n", /line 4/],
    ["an item without a variable", "env:\n  - value: x\n", /variable/],
    ["a value and a secret together", "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    secret: y\n", /both a value and a secret/],
    ["neither a value nor a secret", "env:\n  - variable: NEXT_PUBLIC_A\n", /neither/],
    ["an unknown availability", "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    availability:\n      - EDGE\n", /availability/],
    ["a repeated variable", "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n  - variable: NEXT_PUBLIC_A\n    value: y\n", /more than once/],
    ["a stray line", "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n  garbage\n", /line 4/],
    ["an unterminated quote", 'env:\n  - variable: NEXT_PUBLIC_A\n    value: "abc\n', /line 3/],
    ["a backslash escape it doesn't read", 'env:\n  - variable: NEXT_PUBLIC_A\n    value: "a\\nb"\n', /line 3/],
    ["a number written without quotes, which YAML would read as a number", "env:\n  - variable: NEXT_PUBLIC_A\n    value: 0x1F\n", /quote/],
    ["a boolean written without quotes", "env:\n  - variable: NEXT_PUBLIC_A\n    value: true\n", /quote/],
  ])("throws on %s", (_name, text, message) => {
    expect(() => parseEnv(text)).toThrow(message);
  });
});

describe("buildTimeEnv", () => {
  const parse = (body) => parseEnv(`env:\n${body}`);

  it("keeps values available at build time, including those with no availability, in file order", () => {
    const pairs = buildTimeEnv(
      parse(
        [
          "  - variable: NEXT_PUBLIC_RUNTIME_ONLY",
          "    value: r",
          "    availability: [RUNTIME]",
          "  - variable: NEXT_PUBLIC_BOTH",
          "    value: b",
          "    availability: [BUILD, RUNTIME]",
          "  - variable: NEXT_PUBLIC_DEFAULT",
          "    value: d",
          "  - variable: NEXT_PUBLIC_BUILD_ONLY",
          "    value: o",
          "    availability: [BUILD]",
          "",
        ].join("\n"),
      ),
    );
    expect(pairs).toEqual([
      ["NEXT_PUBLIC_BOTH", "b"],
      ["NEXT_PUBLIC_DEFAULT", "d"],
      ["NEXT_PUBLIC_BUILD_ONLY", "o"],
    ]);
  });

  it("never passes a secret to the build, whatever its availability", () => {
    const pairs = buildTimeEnv(parse("  - variable: NEXT_PUBLIC_S\n    secret: S@1\n    availability: [BUILD]\n"));
    expect(pairs).toEqual([]);
  });

  it("refuses a build-time variable that is not NEXT_PUBLIC_, since it would go into the job's environment", () => {
    expect(() => buildTimeEnv(parse("  - variable: NODE_OPTIONS\n    value: x\n    availability: [BUILD]\n"))).toThrow(/NEXT_PUBLIC_/);
    expect(() => buildTimeEnv(parse("  - variable: LD_PRELOAD\n    value: x\n"))).toThrow(/NEXT_PUBLIC_/);
  });

  it("does not mind a runtime-only variable of any name", () => {
    expect(buildTimeEnv(parse("  - variable: BLOCKSCOUT_API_KEY\n    value: x\n    availability: [RUNTIME]\n"))).toEqual([]);
  });

  it("refuses a value that could start a second variable", () => {
    const withNewline = [["NEXT_PUBLIC_A", "x\nNODE_OPTIONS=--require /tmp/evil.js"]];
    expect(() => render(withNewline)).toThrow(/single line/);
    expect(() => render([["NEXT_PUBLIC_A", "a\rb"]])).toThrow(/single line/);
  });
});

describe("render", () => {
  it("writes NAME=value lines", () => {
    expect(render([["NEXT_PUBLIC_A", "mainnet"], ["NEXT_PUBLIC_B", "https://example.org"]])).toBe(
      "NEXT_PUBLIC_A=mainnet\nNEXT_PUBLIC_B=https://example.org\n",
    );
  });
});

describe("run", () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { write: (s) => out.push(s), error: (s) => err.push(s) } };
  };

  it("prints the build-time NAME=value lines of the file it is given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "env:\n  - variable: NEXT_PUBLIC_A\n    value: mainnet\n    availability: [BUILD]\n");
    const c = capture();
    expect(run([file], c.io)).toBe(0);
    expect(c.out.join("")).toBe("NEXT_PUBLIC_A=mainnet\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails, printing nothing to stdout, when the file can't be read or understood", () => {
    const missing = capture();
    expect(run([path.join(os.tmpdir(), "no-such-apphosting.yaml")], missing.io)).toBe(1);
    expect(missing.out).toEqual([]);
    expect(missing.err.join("\n")).toMatch(/cannot read/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    surprise: 1\n");
    const bad = capture();
    expect(run([file], bad.io)).toBe(1);
    expect(bad.out).toEqual([]);
    expect(bad.err.join("\n")).toMatch(/line 4/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("merges apphosting.<environment>.yaml, from the same folder, over the file when --environment names one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "env:\n  - variable: NEXT_PUBLIC_A\n    value: mainnet\n  - variable: NEXT_PUBLIC_B\n    value: b\n");
    fs.writeFileSync(path.join(dir, "apphosting.testnet.yaml"), "env:\n  - variable: NEXT_PUBLIC_A\n    value: testnet\n");
    const c = capture();
    expect(run([file, "--environment", "testnet"], c.io)).toBe(0);
    expect(c.out.join("").split("\n").filter(Boolean).sort()).toEqual(["NEXT_PUBLIC_A=testnet", "NEXT_PUBLIC_B=b"]);
    // An empty name is no environment, as on App Hosting: the base file alone.
    const bare = capture();
    expect(run([file, "--environment", ""], bare.io)).toBe(0);
    expect(bare.out.join("")).toBe("NEXT_PUBLIC_A=mainnet\nNEXT_PUBLIC_B=b\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the environment's file is missing, since the build would silently be the base file's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "env:\n  - variable: NEXT_PUBLIC_A\n    value: mainnet\n");
    const c = capture();
    expect(run([file, "--environment", "testnet"], c.io)).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err.join("\n")).toMatch(/apphosting\.testnet\.yaml/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the file a bad line is in", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "env:\n  - variable: NEXT_PUBLIC_A\n    value: mainnet\n");
    fs.writeFileSync(path.join(dir, "apphosting.testnet.yaml"), "env:\n  - variable: NEXT_PUBLIC_A\n    value: x\n    surprise: 1\n");
    const c = capture();
    expect(run([file, "--environment", "testnet"], c.io)).toBe(1);
    expect(c.err.join("\n")).toMatch(/apphosting\.testnet\.yaml line 4/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["a name that could leave the folder", ["--environment", "../x"]],
    ["a name with capitals, which App Hosting's file names don't take", ["--environment", "Testnet"]],
    ["--environment without a name", ["--environment"]],
    ["an unknown option", ["--env", "testnet"]],
    ["two files", ["a.yaml", "b.yaml"]],
  ])("refuses %s", (_name, args) => {
    const c = capture();
    expect(run(args, c.io)).toBe(2);
    expect(c.out).toEqual([]);
  });

  it("fails when the file gives the build nothing, since a bundle built without its settings would not be the site's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apphosting-env-"));
    const file = path.join(dir, "apphosting.yaml");
    fs.writeFileSync(file, "runConfig:\n  minInstances: 0\n");
    const c = capture();
    expect(run([file], c.io)).toBe(1);
    expect(c.err.join("\n")).toMatch(/no build-time/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
