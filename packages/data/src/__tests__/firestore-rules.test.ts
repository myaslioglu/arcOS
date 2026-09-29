import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const rules = readFileSync(path.join(ROOT, "firestore/arcos.rules"), "utf8");
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("firestore/arcos.rules", () => {
  it("is a Firestore ruleset over every document", () => {
    expect(code).toMatch(/service\s+cloud\.firestore\s*\{/);
    expect(code).toMatch(/match\s+\/databases\/\{database\}\/documents\s*\{/);
    expect(code).toMatch(/match\s+\/\{document=\*\*\}\s*\{/);
  });

  it("allows nothing: its one allow statement refuses read and write", () => {
    expect(code.match(/\ballow\b/g)).toHaveLength(1);
    expect(code.replace(/\s+/g, " ")).toContain("allow read, write: if false;");
  });
});
