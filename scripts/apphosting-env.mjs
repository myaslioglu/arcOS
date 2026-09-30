#!/usr/bin/env node
// Prints the values App Hosting gives the build, read from apps/web/apphosting.yaml, as NAME=value lines, so the deploy
// workflow can build the same bundle a backend is built from without copying any of them into the workflow:
//
//   node scripts/apphosting-env.mjs [apps/web/apphosting.yaml] [--environment <name>] >> "$GITHUB_ENV"
//
// With --environment, it reads apphosting.<name>.yaml from the same folder and merges it over the base file the way App
// Hosting does for a backend whose environment name is <name> (https://firebase.google.com/docs/app-hosting/multiple-environments):
// an item of the environment's file replaces the base item of the same variable whole (its value or secret and its
// availability), base items it doesn't name are kept, and items only it names are added. Unlike App Hosting, which falls
// back to the base file when the environment's file is missing, this fails: a bundle built without it would be another
// site's. An empty name means no environment, as on App Hosting.
//
// It reads only the shape that file has (an `env:` list of variable / value or secret / availability items) and
// refuses anything else, by line, rather than guessing. A variable is a build-time one when its availability lists
// BUILD or when it has none, as in the Firebase CLI. Secrets are never printed, and a build-time value must be a
// NEXT_PUBLIC_ one: the lines go into a job that later holds a deploy credential, so a name like NODE_OPTIONS or
// LD_PRELOAD is not something a settings file may set there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = "apps/web/apphosting.yaml";
const KEYS = new Set(["variable", "value", "secret", "availability"]);
const AVAILABILITY = new Set(["BUILD", "RUNTIME"]);
const BUILD_NAME = /^NEXT_PUBLIC_[A-Z0-9_]+$/;
/** The environment names whose apphosting.<name>.yaml the Firebase CLI recognises (APPHOSTING_YAML_FILE_REGEX). */
const ENVIRONMENT_NAME = /^[a-z0-9_]+$/;

function failIn(file, line, message) {
  throw new Error(`${file} line ${line}: ${message}`);
}

/** One YAML scalar: double-quoted, single-quoted, or plain text that YAML would read as a string. */
function parseScalar(raw, line, fail) {
  const text = raw.trim();
  if (text === "") fail(line, "missing value");
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let out = "";
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (quote === '"' && ch === "\\") {
        const next = text[i + 1];
        if (next !== '"' && next !== "\\") fail(line, 'only \\" and \\\\ are read as escapes in a double-quoted value');
        out += next;
        i += 1;
      } else if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        const rest = text.slice(i + 1).trim();
        if (rest !== "" && !rest.startsWith("#")) fail(line, "unexpected text after the closing quote");
        return out;
      } else {
        out += ch;
      }
    }
    return fail(line, "unterminated quote");
  }
  const plain = text.replace(/\s+#.*$/, "").trim();
  // YAML reads 0x1F, 12 or true as a number or boolean, and String() of that is not what was written: quote it.
  if (!/^[A-Za-z]/.test(plain) || /^(true|false|null)$/i.test(plain)) fail(line, "quote this value: YAML would read it as a number, boolean or null");
  if (/:(\s|$)/.test(plain)) fail(line, "unsupported plain value (it has a colon and a space)");
  return plain;
}

/**
 * The env items of an apphosting.yaml, in file order: { line, file, variable, value?, secret?, availability? }. `name`
 * is the file's name, which errors give with the line.
 */
export function parseEnv(text, name = "apphosting.yaml") {
  const fail = (line, message) => failIn(name, line, message);
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let inEnv = false;
  let itemIndent = null;
  let current = null;
  let inAvailability = false;

  const setKey = (key, rest, line) => {
    if (!KEYS.has(key)) fail(line, `unknown key "${key}"`);
    if (Object.hasOwn(current, key)) fail(line, `"${key}" is given twice`);
    inAvailability = false;
    if (key === "availability") {
      const value = rest.trim().replace(/\s+#.*$/, "");
      if (value === "") {
        current.availability = [];
        inAvailability = true;
      } else if (value.startsWith("[") && value.endsWith("]")) {
        current.availability = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        fail(line, "availability must be a list");
      }
    } else {
      current[key] = parseScalar(rest, line, fail);
    }
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*(#.*)?$/.test(raw)) return;
    const body = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes("\t")) fail(line, "tabs are not allowed in indentation");
    if (indent === 0) {
      const top = body.match(/^([A-Za-z_][\w-]*):(.*)$/);
      if (!top) fail(line, "unsupported syntax");
      inEnv = top[1] === "env";
      current = null;
      itemIndent = null;
      inAvailability = false;
      if (inEnv && top[2].trim() !== "" && !top[2].trim().startsWith("#")) fail(line, "env must be a list on the lines below it");
      return;
    }
    if (!inEnv) return; // another block, such as runConfig: not read
    if (inAvailability && current && body.startsWith("- ") && indent > itemIndent + 2) {
      current.availability.push(parseScalar(body.slice(2), line, fail));
      return;
    }
    const item = body.match(/^- ([A-Za-z]+):(.*)$/);
    if (item) {
      if (itemIndent === null) itemIndent = indent;
      else if (indent !== itemIndent) fail(line, "list items must line up");
      current = { line, file: name };
      entries.push(current);
      setKey(item[1], item[2], line);
      return;
    }
    const pair = body.match(/^([A-Za-z]+):(.*)$/);
    if (pair && current && indent === itemIndent + 2) {
      setKey(pair[1], pair[2], line);
      return;
    }
    fail(line, "unsupported syntax");
  });

  const seen = new Set();
  for (const e of entries) {
    if (e.variable === undefined) fail(e.line, "an env item needs a variable");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.variable)) fail(e.line, "the variable name is not a plain identifier");
    if (e.value !== undefined && e.secret !== undefined) fail(e.line, `${e.variable} has both a value and a secret`);
    if (e.value === undefined && e.secret === undefined) fail(e.line, `${e.variable} has neither a value nor a secret`);
    if (e.availability && !e.availability.every((a) => AVAILABILITY.has(a))) fail(e.line, `${e.variable}: availability must be BUILD or RUNTIME`);
    if (seen.has(e.variable)) fail(e.line, `${e.variable} is listed more than once`);
    seen.add(e.variable);
  }
  return entries;
}

/**
 * The base file's items with an environment's merged over them, as App Hosting merges apphosting.<environment>.yaml
 * over apphosting.yaml: an environment item replaces the base item of the same variable whole, and the others of both
 * are kept. In App Hosting's order: the environment's items, then the base items it doesn't name.
 */
export function mergeEnv(base, environment) {
  const named = new Set(environment.map((e) => e.variable));
  return [...environment, ...base.filter((e) => !named.has(e.variable))];
}

const atBuild = (e) => !e.availability || e.availability.includes("BUILD");

/** [name, value] for each literal value the build gets. Secrets are left out; a name other than NEXT_PUBLIC_* throws. */
export function buildTimeEnv(entries) {
  const pairs = [];
  for (const e of entries) {
    if (!atBuild(e) || e.secret !== undefined) continue;
    if (!BUILD_NAME.test(e.variable)) {
      failIn(e.file ?? "apphosting.yaml", e.line, `${e.variable} is set at build time but is not NEXT_PUBLIC_*; it would go into the deploy job's environment, so this script refuses it (extend it on purpose if it is needed)`);
    }
    pairs.push([e.variable, e.value]);
  }
  return pairs;
}

/** NAME=value lines; a value with a line break or another control character could start a second variable, so it throws. */
export function render(pairs) {
  return pairs
    .map(([name, value]) => {
      if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new Error(`${name}: a value must be a single line of plain text`);
      return `${name}=${value}\n`;
    })
    .join("");
}

/** The file and the environment name of a command line, or an error for one this script doesn't take. */
function parseArgs(argv) {
  let file;
  let environment = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--environment") {
      if (i + 1 >= argv.length) return { error: "--environment needs a name (an empty one for none)" };
      environment = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else {
      return { error: "one settings file only" };
    }
  }
  if (environment !== "" && !ENVIRONMENT_NAME.test(environment)) {
    return { error: "an environment name is lower-case letters, digits and _ only, as in apphosting.<name>.yaml" };
  }
  return { file: file ?? DEFAULT_FILE, environment };
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void, error: (s: string) => void }} io
 * @returns {number} 0 printed, 1 a file can't be read or understood, 2 a bad command line
 */
export function run(argv, io) {
  const args = parseArgs(argv);
  if (args.error) {
    io.error(`${args.error}\nusage: node scripts/apphosting-env.mjs [apphosting.yaml] [--environment <name>]`);
    return 2;
  }
  const files = [args.file];
  if (args.environment) files.push(path.join(path.dirname(args.file), `apphosting.${args.environment}.yaml`));
  const texts = [];
  for (const file of files) {
    try {
      texts.push(fs.readFileSync(file, "utf8"));
    } catch {
      io.error(`cannot read ${file}`);
      return 1;
    }
  }
  let output;
  try {
    const [base, environment] = texts.map((text, i) => parseEnv(text, path.basename(files[i])));
    const entries = environment ? mergeEnv(base, environment) : base;
    const pairs = buildTimeEnv(entries);
    if (pairs.length === 0) {
      io.error(`no build-time values in ${files.join(" and ")}: a bundle built without the site's settings would not be the site's`);
      return 1;
    }
    output = render(pairs);
    for (const e of entries) {
      if (e.secret !== undefined && atBuild(e)) io.error(`warning: ${e.variable} is a secret at build time on App Hosting; this job's build does not have it`);
    }
  } catch (e) {
    io.error(e instanceof Error ? e.message : "cannot read the file");
    return 1;
  }
  io.write(output);
  return 0;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = run(process.argv.slice(2), { write: (s) => process.stdout.write(s), error: (s) => console.error(s) });
}
