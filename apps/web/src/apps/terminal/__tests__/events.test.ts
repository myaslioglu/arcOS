import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, countedCommand } from "../commands";

describe("countedCommand", () => {
  it("is the command's name for each known command, in any case", () => {
    for (const name of COMMAND_NAMES) {
      expect(countedCommand(name), name).toBe(name);
      expect(countedCommand(name.toUpperCase()), name).toBe(name);
    }
  });

  it("is only the name: never an argument, however many or whatever they are", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    expect(countedCommand(`balance ${wallet}`)).toBe("balance");
    expect(countedCommand(`  inspect   ${wallet}  extra words `)).toBe("inspect");
    expect(countedCommand("open about")).toBe("open");
    expect(countedCommand("theme dark")).toBe("theme");
    expect(countedCommand(`approvals ${wallet}`)).toBe("approvals");
  });

  it("is unknown for a word that isn't a command, including an address typed where a command goes", () => {
    for (const line of [
      "nosuchcommand --secret",
      "sudo rm -rf /",
      "0x1111111111111111111111111111111111111111",
      "0x1111111111111111111111111111111111111111 balance",
      "helpme",
      "hel",
      "",
      "   ",
    ]) {
      expect(countedCommand(line), JSON.stringify(line)).toBe("unknown");
    }
  });

  it("is unknown for a name that only exists on a prototype", () => {
    for (const line of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype"]) {
      expect(countedCommand(line), line).toBe("unknown");
    }
  });

  it("gives a name /api/event will take: 32 characters or fewer of letters, digits, dot, underscore and hyphen", () => {
    for (const name of [...COMMAND_NAMES, "unknown"]) {
      expect(name, name).toMatch(/^[A-Za-z0-9_.-]{1,32}$/);
    }
  });
});

/**
 * A source scan: the window can't be mounted here, so this pins where the count is made. One call, after the guard that
 * ignores a blank line, and what it hands over is countedCommand's answer, not the typed line.
 */
describe("Window.tsx counts each run once, by the command's name", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const run = source.match(/const run = \(raw: string\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";

  it("makes exactly one trackEvent call in the file", () => {
    expect(run, "the run function").not.toBe("");
    expect([...source.matchAll(/\btrackEvent\(/g)]).toHaveLength(1);
  });

  it("makes it in run, after a blank line has been turned away, with the counted command and nothing typed", () => {
    expect(run).toMatch(/if \(!typed\) return;[\s\S]*trackEvent\("terminal_run", \{ command: countedCommand\(typed\) \}\);/);
  });
});
