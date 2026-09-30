import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeEnv, parseEnv, render, run } from "./apphosting-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const realFile = path.join(here, "..", "apps", "web", "apphosting.yaml");

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
