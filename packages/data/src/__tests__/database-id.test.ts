import { describe, expect, it } from "vitest";
import { DataError } from "../errors";
import { resolveDatabaseId } from "../server/database-id";

const named = (value: string) => resolveDatabaseId({ ARCOS_FIRESTORE_DATABASE: value });

/** What a call refused with; fails the test when it throws anything but a DataError, or does not throw. */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DataError);
    return { code: (error as DataError).code, message: (error as DataError).message };
  }
  throw new Error("expected the call to throw");
}

describe("resolveDatabaseId", () => {
  it("is arcos when nothing overrides it", () => {
    expect(resolveDatabaseId({})).toBe("arcos");
    expect(resolveDatabaseId({ ARCOS_FIRESTORE_DATABASE: undefined })).toBe("arcos");
  });

  it("counts an empty or blank value as unset, so it can never mean (default)", () => {
    for (const value of ["", " ", "\t\n"]) expect(named(value), JSON.stringify(value)).toBe("arcos");
  });

  it("takes an override that names a database, trimmed", () => {
    expect(named("arcos-scratch")).toBe("arcos-scratch");
    expect(named("  arcos-scratch \n")).toBe("arcos-scratch");
  });

  it("accepts the shortest and the longest id Firestore allows", () => {
    expect(named("abcd")).toBe("abcd");
    expect(named(`a${"b".repeat(62)}`)).toHaveLength(63);
  });

  it("refuses (default) and everything else that is not a named database", () => {
    const bad = ["(default)", "default)", "Arcos", "a/b", "abc", "a".repeat(64), "arcos-", "1arcos", "ar cos", "arcos_x"];
    for (const value of bad) expect(refusal(() => named(value)).code, value).toBe("database-id");
  });

  it("does not repeat the value it refused", () => {
    expect(refusal(() => named("Some Odd Value")).message).not.toContain("Odd");
  });
});
