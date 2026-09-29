// Tests for scan-bundle.mjs. Every "forbidden" string here is an obvious fake; the real patterns live in a
// repository secret and never enter the repo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countMatches, parsePatterns, run } from "./scan-bundle.mjs";

const FAKE_WORD = "zz-fake-forbidden-word";
const FAKE_ADDRESS = `0x${"1".repeat(40)}`;

/** What run() writes, split by stream. */
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { log: (l) => out.push(l), error: (l) => err.push(l) }, all: () => [...out, ...err].join("\n") };
}

let root;
let staticDir;
let serverDir;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-bundle-"));
  staticDir = path.join(root, "static");
  serverDir = path.join(root, "server");
  write(path.join(staticDir, "chunks", "app.js"), "console.log('hello world');");
  write(path.join(serverDir, "app", "page.js"), "export default function Page() { return 'hi'; }");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parsePatterns", () => {
  it("numbers each pattern by its line in the secret and skips blank lines", () => {
    const { patterns, problems } = parsePatterns("\nfoo\n\n  bar  \r\n");
    expect(problems).toEqual([]);
    expect(patterns.map((p) => p.line)).toEqual([2, 4]);
  });

  it("compiles every pattern global and case-insensitive", () => {
    const { patterns } = parsePatterns("abc");
    expect(patterns[0].regex.flags).toContain("g");
    expect(patterns[0].regex.flags).toContain("i");
    expect("xxABCxx".match(patterns[0].regex)).not.toBeNull();
  });

  it("reports an invalid expression by its line and never carries its text", () => {
    const { patterns, problems } = parsePatterns(`ok\n(${FAKE_WORD}\n`);
    expect(patterns).toHaveLength(1);
    expect(problems).toEqual([{ line: 2, reason: "invalid" }]);
    expect(JSON.stringify(problems)).not.toContain(FAKE_WORD);
  });

  it.each(["x*", "(?:)", "^", "$"])("rejects %s, which matches the empty string", (pattern) => {
    const { patterns, problems } = parsePatterns(pattern);
    expect(patterns).toEqual([]);
    expect(problems).toEqual([{ line: 1, reason: "empty-match" }]);
  });

  it.each(["/pattern/", "/pattern/i", "/pattern/gi", "/a/b/"])(
    "rejects %s, a /pattern/flags literal: its slashes would be searched for, so it would never match",
    (pattern) => {
      const { patterns, problems } = parsePatterns(pattern);
      expect(patterns).toEqual([]);
      expect(problems).toEqual([{ line: 1, reason: "delimited" }]);
    },
  );

  it.each([..."dgimsuvy"])("rejects /pattern/%s, whichever flag letter follows the slash", (flag) => {
    expect(parsePatterns(`/pattern/${flag}`).problems).toEqual([{ line: 1, reason: "delimited" }]);
  });

  it.each(['"pattern"', "'pattern'", "`pattern`"])("rejects %s, wrapped in quotes that would be searched for", (pattern) => {
    const { patterns, problems } = parsePatterns(pattern);
    expect(patterns).toEqual([]);
    expect(problems).toEqual([{ line: 1, reason: "quoted" }]);
  });

  // Not pasted as a literal: no /flags run after the last slash, or no pair of the same quote around the whole line.
  // A slash or quote that belongs to the text stays possible: escape the first one.
  it.each([
    "/etc/hosts",
    "/api/pulse",
    "\\/pattern\\/",
    "\\\"pattern\"",
    "it's",
    'say "hi"',
    "a/b",
    "'pattern\"",
    '"pattern`',
    '"key": "value',
  ])("accepts %s", (pattern) => {
    expect(parsePatterns(pattern).problems).toEqual([]);
  });

  it("reads nothing from an undefined or empty secret", () => {
    expect(parsePatterns(undefined)).toEqual({ patterns: [], problems: [] });
    expect(parsePatterns("")).toEqual({ patterns: [], problems: [] });
    expect(parsePatterns(" \n\t\n")).toEqual({ patterns: [], problems: [] });
  });
});

describe("countMatches", () => {
  it("counts every match, ignoring case, and 0 when there is none", () => {
    const { patterns } = parsePatterns("cat");
    const re = patterns[0].regex;
    expect(countMatches("Cat cat CAT concat", re)).toBe(4);
    expect(countMatches("dog", re)).toBe(0);
  });
});

describe("run", () => {
  it("passes and prints one count line per pattern when nothing matches", async () => {
    const c = capture();
    const code = await run([staticDir, serverDir], { BUNDLE_DENY_PATTERNS: `${FAKE_WORD}\n${FAKE_ADDRESS}` }, c.io);
    expect(code).toBe(0);
    expect(c.out).toContain("pattern 1: 0 matches");
    expect(c.out).toContain("pattern 2: 0 matches");
    expect(c.all()).not.toContain(FAKE_WORD);
    expect(c.all()).not.toContain(FAKE_ADDRESS);
  });

  it("fails when any pattern matches, names it by number only, and never prints the pattern or the text", async () => {
    write(path.join(staticDir, "chunks", "leak.js"), `var a="${FAKE_WORD}";var b="${FAKE_WORD.toUpperCase()}";`);
    write(path.join(serverDir, "app", "leak.html"), `<p>${FAKE_WORD}</p>`);
    const c = capture();
    const code = await run([staticDir, serverDir], { BUNDLE_DENY_PATTERNS: `nothing-here-at-all\n${FAKE_WORD}\n${FAKE_ADDRESS}` }, c.io);
    expect(code).toBe(1);
    expect(c.out).toContain("pattern 1: 0 matches");
    expect(c.out).toContain("pattern 2: 3 matches");
    expect(c.out).toContain("pattern 3: 0 matches");
    const everything = c.all();
    expect(everything).not.toContain(FAKE_WORD);
    expect(everything).not.toContain(FAKE_WORD.toUpperCase());
    expect(everything).not.toContain("nothing-here-at-all");
    expect(everything).not.toContain(FAKE_ADDRESS);
    expect(everything).not.toContain("leak.js"); // no file names either
    for (const line of c.out) expect(line).toMatch(/^(pattern \d+: \d+ matches|scan: .*|FAIL: .*|OK: .*)$/);
  });

  it("still fails when only one of many patterns matches", async () => {
    write(path.join(serverDir, "x.json"), FAKE_ADDRESS);
    const c = capture();
    const code = await run([serverDir], { BUNDLE_DENY_PATTERNS: `a-1\na-2\na-3\n${FAKE_ADDRESS}` }, c.io);
    expect(code).toBe(1);
    expect(c.out).toContain("pattern 4: 1 matches");
  });

  it("finds a match inside a binary file", async () => {
    write(path.join(staticDir, "media", "font.woff2"), Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from(FAKE_WORD), Buffer.from([0, 0, 9])]));
    const c = capture();
    const code = await run([staticDir], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io);
    expect(code).toBe(1);
    expect(c.out).toContain("pattern 1: 1 matches");
  });

  describe("fails closed", () => {
    it.each([
      ["the secret is missing", {}],
      ["the secret is empty", { BUNDLE_DENY_PATTERNS: "" }],
      ["the secret holds only blank lines", { BUNDLE_DENY_PATTERNS: "\n  \n\t\n" }],
    ])("when %s", async (_name, env) => {
      const c = capture();
      const code = await run([staticDir, serverDir], env, c.io);
      expect(code).toBe(2);
      expect(c.err.join("\n")).toMatch(/no deny patterns/i);
      expect(c.out.filter((l) => l.startsWith("pattern"))).toEqual([]);
    });

    it("when a pattern is not a valid expression, naming its line only", async () => {
      const c = capture();
      const code = await run([staticDir], { BUNDLE_DENY_PATTERNS: `fine\n(${FAKE_WORD}\n` }, c.io);
      expect(code).toBe(2);
      expect(c.err.join("\n")).toContain("pattern 2 is not a valid regular expression");
      expect(c.all()).not.toContain(FAKE_WORD);
      expect(c.out.filter((l) => l.startsWith("pattern"))).toEqual([]); // no partial scan with a broken list
    });

    it("when a pattern matches the empty string", async () => {
      const c = capture();
      const code = await run([staticDir], { BUNDLE_DENY_PATTERNS: "x*" }, c.io);
      expect(code).toBe(2);
      expect(c.err.join("\n")).toContain("pattern 1 matches the empty string");
    });

    it("when a pattern is pasted as a /pattern/flags literal or inside quotes, which would silently match nothing", async () => {
      const c = capture();
      const code = await run([staticDir], { BUNDLE_DENY_PATTERNS: `ok\n/${FAKE_WORD}/i\n"${FAKE_ADDRESS}"\n` }, c.io);
      expect(code).toBe(2);
      expect(c.err.join("\n")).toContain("pattern 2 is written as /pattern/flags");
      expect(c.err.join("\n")).toContain("pattern 3 is wrapped in quotes");
      expect(c.all()).not.toContain(FAKE_WORD);
      expect(c.all()).not.toContain(FAKE_ADDRESS);
      expect(c.out.filter((l) => l.startsWith("pattern"))).toEqual([]);
    });

    it("when no directory is given", async () => {
      const c = capture();
      expect(await run([], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/directory/i);
    });

    it("when a directory does not exist", async () => {
      const c = capture();
      expect(await run([path.join(root, "missing")], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/not a directory/i);
    });

    it("when a directory holds no files, so an empty build can't pass", async () => {
      const empty = path.join(root, "empty");
      fs.mkdirSync(path.join(empty, "nested"), { recursive: true });
      const c = capture();
      expect(await run([empty], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/no files/i);
    });

    it("when the tree holds something that is not a plain file or directory", async () => {
      fs.symlinkSync(path.join(staticDir, "chunks", "app.js"), path.join(staticDir, "link.js"));
      const c = capture();
      expect(await run([staticDir], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/not a regular file/i);
    });
  });

  it("reads the patterns from --patterns-file instead of the environment", async () => {
    const file = path.join(root, "patterns.txt");
    write(file, `${FAKE_WORD}\n`);
    write(path.join(staticDir, "leak.js"), FAKE_WORD);
    const c = capture();
    const code = await run(["--patterns-file", file, staticDir], { BUNDLE_DENY_PATTERNS: "unused" }, c.io);
    expect(code).toBe(1);
    expect(c.out).toContain("pattern 1: 1 matches");
  });

  it("fails closed when --patterns-file cannot be read", async () => {
    const c = capture();
    expect(await run(["--patterns-file", path.join(root, "nope.txt"), staticDir], {}, c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/cannot read the patterns file/i);
  });

  it("reports the size of what it scanned without naming anything", async () => {
    const c = capture();
    await run([staticDir, serverDir], { BUNDLE_DENY_PATTERNS: FAKE_WORD }, c.io);
    expect(c.out.some((l) => /^scan: 2 files, \d+ bytes, 1 pattern$/.test(l))).toBe(true);
  });
});
