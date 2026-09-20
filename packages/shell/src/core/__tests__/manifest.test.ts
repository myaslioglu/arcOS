import { describe, expect, it } from "vitest";
import { buildRegistry, openActionFor, type AppManifest } from "../manifest";

const stub = (over: Partial<AppManifest>): AppManifest => ({
  id: "x",
  name: "X",
  blurb: "",
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "system",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});

describe("buildRegistry", () => {
  it("indexes manifests by id and keeps order", () => {
    const r = buildRegistry([stub({ id: "a" }), stub({ id: "b" })]);
    expect(r.list.map((m) => m.id)).toEqual(["a", "b"]);
    expect(r.byId.get("b")?.id).toBe("b");
  });

  it("rejects duplicate ids", () => {
    expect(() => buildRegistry([stub({ id: "a" }), stub({ id: "a" })])).toThrow(/duplicate app id "a"/);
  });
});

describe("openActionFor", () => {
  const registry = buildRegistry([
    stub({ id: "mint", name: "Mint", window: { w: 440, h: 560 } }),
    stub({
      id: "inspector",
      name: "Inspector",
      window: { w: 520, h: 640, flush: true },
      instanceKey: (p) => (p.token ?? "").toLowerCase(),
    }),
  ]);

  it("returns null for an unknown app", () => {
    expect(openActionFor(registry, "nope", {})).toBeNull();
  });

  it("opens a singleton with an empty instance key", () => {
    expect(openActionFor(registry, "mint", {})).toEqual({
      type: "open",
      appId: "mint",
      instanceKey: "",
      params: {},
      title: "Mint",
      size: { w: 440, h: 560 },
      flush: false,
    });
  });

  it("derives the instance key from params", () => {
    const a = openActionFor(registry, "inspector", { token: "0xABC" });
    expect(a?.instanceKey).toBe("0xabc");
    expect(a?.flush).toBe(true);
  });
});
