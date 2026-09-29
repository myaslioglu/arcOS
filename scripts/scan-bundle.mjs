#!/usr/bin/env node
// Scans built files for strings that must never ship, and fails when any is there.
//
//   BUNDLE_DENY_PATTERNS="<one regular expression per line>" node scripts/scan-bundle.mjs <dir> [<dir> ...]
//   node scripts/scan-bundle.mjs --patterns-file <file> <dir> [<dir> ...]     (for a local run)
//
// The deploy workflow passes the patterns in through a repository secret, so they are not in this public repo, and
// so this script never prints one: it prints "pattern N: M matches", N being the pattern's line in the secret, and
// nothing else about what it found (no matched text, no file names). Matching is case-insensitive.
//
// Exit codes: 0 no pattern matched; 1 a pattern matched; 2 the scan could not be trusted to have looked (it fails
// closed): no patterns, a pattern that is not a regular expression, matches the empty string, or is pasted as a
// /pattern/flags literal or inside quotes (each would search for those marks themselves and find nothing), a directory
// that is missing or holds no files, or an entry that is not a plain file or directory.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_NAME = "BUNDLE_DENY_PATTERNS";
const FLAGS = "gi";

// A line pasted the way code writes a regular expression or a string: /text/flags, or text inside one kind of quote.
// As a pattern it would look for the slashes or the quotes as well, so it would match nothing and the scan would pass
// without having looked. A slash that belongs to the text is written \/ (and /etc/hosts, /api/pulse stay accepted:
// what follows their last slash is not a run of flag letters).
const DELIMITED = /^\/.+\/[dgimsuvy]*$/;
const QUOTED = /^(["'`]).+\1$/;

/**
 * The patterns in `text`, one per line, blank lines skipped. Each is numbered by its line, so "pattern 3" is the third
 * line of the secret. A line that isn't a regular expression, one that matches the empty string (it would match
 * everywhere), and one written as /pattern/flags or inside quotes (it would match nothing) is a problem, reported by
 * line and reason only, never by its text.
 */
export function parsePatterns(text) {
  const patterns = [];
  const problems = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const source = raw.trim();
      if (source === "") return;
      const line = index + 1;
      if (DELIMITED.test(source)) {
        problems.push({ line, reason: "delimited" });
        return;
      }
      if (QUOTED.test(source)) {
        problems.push({ line, reason: "quoted" });
        return;
      }
      let regex;
      try {
        regex = new RegExp(source, FLAGS);
      } catch {
        problems.push({ line, reason: "invalid" });
        return;
      }
      if (regex.test("")) {
        problems.push({ line, reason: "empty-match" });
        return;
      }
      regex.lastIndex = 0;
      patterns.push({ line, regex });
    });
  return { patterns, problems };
}

// What run() says about each kind of problem, after "pattern N". Never the pattern itself.
const PROBLEMS = {
  invalid: "is not a valid regular expression",
  "empty-match": "matches the empty string",
  delimited: "is written as /pattern/flags: write the expression without the slashes, or escape the first slash with a backslash if it belongs to the text",
  quoted: "is wrapped in quotes: write the expression without them, or escape the first quote with a backslash if it belongs to the text",
};

/** How many times the global `regex` matches in `text`. */
export function countMatches(text, regex) {
  return text.match(regex)?.length ?? 0;
}

/** Every regular file under `dir`, and how many entries were neither a regular file nor a directory. */
function collectFiles(dir) {
  const files = [];
  let odd = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
      else odd += 1;
    }
  }
  return { files, odd };
}

/**
 * Runs the scan and returns the exit code. `io.log` and `io.error` each take one line.
 * @param {string[]} argv the command line after the script name
 * @param {Record<string, string | undefined>} env
 * @param {{ log: (line: string) => void, error: (line: string) => void }} io
 */
export function run(argv, env, io) {
  let patternsFile;
  const dirs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--patterns-file") {
      patternsFile = argv[i + 1];
      i += 1;
      if (!patternsFile) {
        io.error("usage: --patterns-file needs a path");
        return 2;
      }
    } else if (arg.startsWith("--")) {
      io.error(`usage: unknown option ${arg}`);
      return 2;
    } else {
      dirs.push(arg);
    }
  }

  let text;
  if (patternsFile) {
    try {
      text = fs.readFileSync(patternsFile, "utf8");
    } catch {
      io.error("cannot read the patterns file");
      return 2;
    }
  } else {
    text = env[ENV_NAME];
  }
  const { patterns, problems } = parsePatterns(text);
  if (problems.length > 0) {
    for (const { line, reason } of problems) io.error(`pattern ${line} ${PROBLEMS[reason] ?? PROBLEMS.invalid}`);
    return 2;
  }
  if (patterns.length === 0) {
    io.error(patternsFile ? "no deny patterns: the patterns file holds none" : `no deny patterns: ${ENV_NAME} is empty or missing`);
    return 2;
  }
  if (dirs.length === 0) {
    io.error("usage: give at least one directory to scan");
    return 2;
  }

  const files = [];
  for (const dir of dirs) {
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(dir).isDirectory();
    } catch {
      // reported below
    }
    if (!isDirectory) {
      io.error(`not a directory: ${dir}`);
      return 2;
    }
    const found = collectFiles(dir);
    if (found.odd > 0) {
      io.error(`${found.odd} entries under ${dir} are not a regular file or directory; the scan can't vouch for them`);
      return 2;
    }
    if (found.files.length === 0) {
      io.error(`no files under ${dir}: nothing was built to scan`);
      return 2;
    }
    files.push(...found.files);
  }

  const counts = patterns.map(() => 0);
  let bytes = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    bytes += buffer.length;
    const text = buffer.toString("utf8");
    patterns.forEach(({ regex }, i) => {
      counts[i] += countMatches(text, regex);
    });
  }

  patterns.forEach(({ line }, i) => io.log(`pattern ${line}: ${counts[i]} matches`));
  io.log(`scan: ${files.length} files, ${bytes} bytes, ${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"}`);
  const hit = counts.filter((n) => n > 0).length;
  if (hit > 0) {
    io.error(`FAIL: ${hit} of ${patterns.length} deny patterns matched the built files`);
    return 1;
  }
  io.log("OK: no deny pattern matched");
  return 0;
}

// Run as a script (not when a test imports it).
const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    process.exitCode = run(process.argv.slice(2), process.env, { log: console.log, error: console.error });
  } catch (e) {
    // The error's name and code only: a message could carry a path or, for a bad expression, the pattern itself.
    console.error(`scan failed: unexpected ${e instanceof Error ? e.name : "error"}${e && e.code ? ` ${e.code}` : ""}`);
    process.exitCode = 2;
  }
}
