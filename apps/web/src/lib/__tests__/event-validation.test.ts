import { describe, expect, it } from "vitest";
import { EVENT_NAMES, EVENT_PROPS } from "../events";
import { isOwnOrigin, validateEvent } from "../event-validation";

const event = (name: unknown, props?: unknown) => validateEvent({ name, props });

describe("the event list", () => {
  it("names the nine events, each with only its own props", () => {
    expect(EVENT_PROPS).toEqual({
      inspect_run: ["passed", "total"],
      fix_click: ["app"],
      proof_share: [],
      mint_success: ["mintable", "burnable"],
      drop_success: ["recipients", "batches"],
      swap_success: ["pair"],
      bridge_success: ["from", "to"],
      revoke_success: [],
      terminal_run: ["command"],
    });
    expect(EVENT_NAMES).toHaveLength(9);
  });
});

describe("validateEvent: the name", () => {
  it("counts each known event, with its own props", () => {
    expect(event("inspect_run", { passed: 5, total: 8 })).toEqual({ event: "inspect_run", props: { passed: 5, total: 8 } });
    expect(event("fix_click", { app: "vault" })).toEqual({ event: "fix_click", props: { app: "vault" } });
    expect(event("proof_share")).toEqual({ event: "proof_share", props: {} });
    expect(event("mint_success", { mintable: 1, burnable: 0 })).toEqual({ event: "mint_success", props: { mintable: 1, burnable: 0 } });
    expect(event("drop_success", { recipients: 120, batches: 1 })).toEqual({ event: "drop_success", props: { recipients: 120, batches: 1 } });
    expect(event("swap_success", { pair: "USDC-EURC" })).toEqual({ event: "swap_success", props: { pair: "USDC-EURC" } });
    expect(event("bridge_success", { from: "Ethereum_Sepolia", to: "Arc_Testnet" })).toEqual({
      event: "bridge_success",
      props: { from: "Ethereum_Sepolia", to: "Arc_Testnet" },
    });
    expect(event("revoke_success")).toEqual({ event: "revoke_success", props: {} });
    expect(event("terminal_run", { command: "balance" })).toEqual({ event: "terminal_run", props: { command: "balance" } });
  });

  it("counts nothing whose name isn't in the list, prototype names included", () => {
    for (const name of ["nope", "", "INSPECT_RUN", " inspect_run", "inspect_run ", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", 5, null, undefined, true, ["inspect_run"], { a: 1 }]) {
      expect(event(name), String(name)).toBeNull();
    }
  });

  it("counts nothing from a body that isn't an object with a name", () => {
    for (const body of [null, undefined, "inspect_run", 5, true, [], [{ name: "inspect_run" }], {}, { event: "inspect_run" }, { props: {} }]) {
      expect(validateEvent(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("validateEvent: the props", () => {
  it("keeps only the props the event is allowed, and drops the rest without dropping the event", () => {
    expect(event("proof_share", { app: "vault", anything: 1 })).toEqual({ event: "proof_share", props: {} });
    expect(event("revoke_success", { command: "help", wallet: "x" })).toEqual({ event: "revoke_success", props: {} });
    expect(event("inspect_run", { passed: 3, total: 8, app: "vault", extra: 1, __proto__x: 2 })).toEqual({
      event: "inspect_run",
      props: { passed: 3, total: 8 },
    });
    // Another event's prop is not this event's.
    expect(event("swap_success", { pair: "USDC-EURC", from: "Base", command: "help" })).toEqual({ event: "swap_success", props: { pair: "USDC-EURC" } });
  });

  it("orders the props as the event lists them, not as the client sent them", () => {
    const counted = event("bridge_success", { to: "Arc", from: "Base" });
    expect(Object.keys(counted!.props)).toEqual(["from", "to"]);
  });

  it("takes a missing, null or non-object props as none", () => {
    for (const props of [undefined, null, "passed=5", 5, true, [], [5, 8]]) {
      expect(event("inspect_run", props), String(props)).toEqual({ event: "inspect_run", props: {} });
    }
  });

  it("reads a prop only from the props' own properties, so nothing comes down a prototype", () => {
    const viaProto = JSON.parse('{"name":"fix_click","props":{"__proto__":{"app":"vault"}}}');
    expect(validateEvent(viaProto)).toEqual({ event: "fix_click", props: {} });
    const inherited = Object.create({ app: "vault" });
    expect(validateEvent({ name: "fix_click", props: inherited })).toEqual({ event: "fix_click", props: {} });
  });

  describe("a number", () => {
    it("is a finite whole number from 0 to 1,000,000", () => {
      for (const n of [0, 1, 8, 200, 999_999, 1_000_000]) {
        expect(event("inspect_run", { passed: n })!.props, String(n)).toEqual({ passed: n });
      }
    });

    it("is dropped when it is negative, over the limit, fractional or not finite, and the event is still counted", () => {
      for (const n of [-1, -1_000_000, 1_000_001, 2 ** 53, 1.5, 0.1, NaN, Infinity, -Infinity]) {
        expect(event("inspect_run", { passed: n, total: 8 }), String(n)).toEqual({ event: "inspect_run", props: { total: 8 } });
      }
    });
  });

  describe("a string", () => {
    it("is up to 32 characters of letters, digits, underscore, dot and hyphen", () => {
      for (const text of ["USDC-EURC", "Ethereum_Sepolia", "a.b-c_d", "x", "A".repeat(32), "0123456789", "v1.2.3"]) {
        expect(event("swap_success", { pair: text })!.props, text).toEqual({ pair: text });
      }
    });

    it("is dropped when it is empty, longer than 32, or holds any other character, and the event is still counted", () => {
      for (const text of ["", "A".repeat(33), "has space", "a/b", "a,b", "a:b", "a;b", "a=b", "<script>", "é", "日本", "a\nb", "tab\t", "quote\"", "0x1111111111111111111111111111111111111111", "a\u200Bb"]) {
        expect(event("swap_success", { pair: text }), JSON.stringify(text)).toEqual({ event: "swap_success", props: {} });
      }
    });

    it("can't carry an address: one is 42 characters, past the limit", () => {
      const address = "0x1111111111111111111111111111111111111111";
      expect(address).toHaveLength(42);
      expect(event("bridge_success", { from: address, to: "Base" })).toEqual({ event: "bridge_success", props: { to: "Base" } });
    });
  });

  it("drops a value of any other kind", () => {
    for (const value of [true, false, null, undefined, {}, [], ["a"], { a: 1 }, () => 1, 10n]) {
      expect(event("swap_success", { pair: value }), String(value)).toEqual({ event: "swap_success", props: {} });
    }
  });

  it("keeps the good props when one is bad", () => {
    expect(event("drop_success", { recipients: -5, batches: 2 })).toEqual({ event: "drop_success", props: { batches: 2 } });
    expect(event("bridge_success", { from: "not valid!", to: "Base" })).toEqual({ event: "bridge_success", props: { to: "Base" } });
  });

  it("takes a string where a number was meant, since only the value's own rules apply", () => {
    expect(event("inspect_run", { passed: "5" })).toEqual({ event: "inspect_run", props: { passed: "5" } });
  });
});

describe("isOwnOrigin", () => {
  const own = ["4rcos.com", undefined, null, "arcos--arcos-c80cf.europe-west4.hosted.app"];

  it("takes a request with no Origin, which a beacon from an old browser or a command line sends", () => {
    expect(isOwnOrigin(null, own)).toBe(true);
  });

  it("takes an origin whose host is the site's own, in any case, on either scheme", () => {
    expect(isOwnOrigin("https://4rcos.com", own)).toBe(true);
    expect(isOwnOrigin("HTTPS://4RCOS.COM", own)).toBe(true);
    expect(isOwnOrigin("https://arcos--arcos-c80cf.europe-west4.hosted.app", own)).toBe(true);
    // The server may see http where the visitor used https: the host is what says whose it is.
    expect(isOwnOrigin("http://4rcos.com", own)).toBe(true);
  });

  it("compares the port too", () => {
    expect(isOwnOrigin("http://localhost:3000", ["localhost:3000"])).toBe(true);
    expect(isOwnOrigin("http://localhost:3001", ["localhost:3000"])).toBe(false);
    expect(isOwnOrigin("http://localhost", ["localhost:3000"])).toBe(false);
  });

  it("refuses another site's origin, one that only starts or ends like the site's own, and one with credentials or a path smuggled in", () => {
    for (const origin of [
      "https://evil.example",
      "https://4rcos.com.evil.example",
      "https://evil4rcos.com",
      "https://sub.4rcos.com",
      "https://4rcos.co",
      "https://4rcos.com:8443",
      "https://4rcos.com@evil.example",
    ]) {
      expect(isOwnOrigin(origin, own), origin).toBe(false);
    }
  });

  it("refuses the opaque origin \"null\", an unparseable one and any scheme but http and https", () => {
    for (const origin of ["null", "", "not a url", "file:///", "chrome-extension://abc", "data:text/plain,x", "javascript:alert(1)"]) {
      expect(isOwnOrigin(origin, own), origin).toBe(false);
    }
  });

  it("refuses everything when the site knows no name of its own", () => {
    expect(isOwnOrigin("https://4rcos.com", [undefined, null, ""])).toBe(false);
    expect(isOwnOrigin("https://4rcos.com", [])).toBe(false);
  });
});
