import { describe, expect, it } from "vitest";
import { DETAILS_MAX, errorFields, nameOf } from "../errors";

/** A Firestore error as @google-cloud/firestore throws it: a gRPC status code, details and metadata. */
const grpcError = (code: number, details: string) =>
  Object.assign(new Error(`${code} SOME_STATUS: ${details}`), { code, details, metadata: {} });

describe("errorFields", () => {
  it("gives a Firestore error's name, code and details, and never its message", () => {
    const fields = errorFields(grpcError(9, "The query requires an index."));
    expect(fields).toEqual({ error: "Error", code: 9, details: "The query requires an index." });
    expect(JSON.stringify(fields)).not.toContain("SOME_STATUS");
  });

  it("cuts details to DETAILS_MAX characters and replaces any URL in them", () => {
    expect(errorFields(grpcError(3, "x".repeat(500))).details).toHaveLength(DETAILS_MAX);
    const fields = errorFields(grpcError(14, "connect failed: https://node.example/key123 refused"));
    expect(fields.details).toBe("connect failed: [url] refused");
  });

  it("gives a JSON-RPC error's code but not its details, which could carry a node's answer", () => {
    const e = Object.assign(new Error("https://node.example/key123 said no"), { code: -32005, details: "https://node.example/key123" });
    expect(errorFields(e)).toEqual({ error: "Error", code: -32005 });
    // Code 3 is a gRPC status and also JSON-RPC's "execution reverted": without metadata, it is not taken for Firestore's.
    const reverted = Object.assign(new Error("reverted"), { code: 3, details: "execution reverted: secret" });
    expect(errorFields(reverted)).toEqual({ error: "Error", code: 3 });
  });

  it("gives a short string code, and leaves out a code that isn't one", () => {
    expect(errorFields(Object.assign(new Error("m"), { code: "ECONNRESET" }))).toEqual({ error: "Error", code: "ECONNRESET" });
    expect(errorFields(Object.assign(new Error("m"), { code: "see https://x.example/a b" }))).toEqual({ error: "Error" });
    expect(errorFields(Object.assign(new Error("m"), { code: { nested: 1 } }))).toEqual({ error: "Error" });
  });

  it("names what isn't an Error 'unknown'", () => {
    expect(errorFields("a string")).toEqual({ error: "unknown" });
    expect(errorFields(null)).toEqual({ error: "unknown" });
    expect(nameOf(new TypeError("t"))).toBe("TypeError");
  });
});
