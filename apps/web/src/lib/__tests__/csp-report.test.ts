import { describe, expect, it } from "vitest";
import { blockedOf, directiveOf, pathOf, violationsFrom } from "../csp-report";

describe("directiveOf", () => {
  it("reads a directive name, and only its first word when a browser sends the whole directive", () => {
    expect(directiveOf("script-src-elem")).toBe("script-src-elem");
    expect(directiveOf("img-src 'self' data: blob: https:")).toBe("img-src");
    expect(directiveOf("  CONNECT-SRC ")).toBe("connect-src");
  });

  it("answers unknown for anything that isn't a directive name", () => {
    for (const v of [undefined, null, 7, {}, [], "", "   ", "x".repeat(41), "../etc", "<script>", "1abc", "'self'"]) {
      expect(directiveOf(v), String(v)).toBe("unknown");
    }
  });
});

describe("blockedOf", () => {
  it("cuts a blocked URL to its origin: no path, no query, no fragment, no credentials", () => {
    expect(blockedOf("https://cdn.example.com/a/b.js?token=secret&x=1#frag")).toBe("https://cdn.example.com");
    expect(blockedOf("wss://relay.walletconnect.org/?auth=abc")).toBe("wss://relay.walletconnect.org");
    expect(blockedOf("https://user:pass@host.example:8443/p?q=1")).toBe("https://host.example:8443");
  });

  it("keeps the keywords a browser reports in place of a URL", () => {
    for (const keyword of ["inline", "eval", "wasm-eval", "data", "blob", "trusted-types-policy", "trusted-types-sink"]) {
      expect(blockedOf(keyword), keyword).toBe(keyword);
    }
    expect(blockedOf("INLINE")).toBe("inline");
  });

  it("reduces a data: or blob: URL to its scheme, and any other scheme to its name", () => {
    expect(blockedOf("data:image/png;base64,AAAA")).toBe("data");
    expect(blockedOf("blob:https://4rcos.com/5f1c9a5e-0000-4000-8000-000000000000")).toBe("blob");
    expect(blockedOf("chrome-extension://abcdefghijklmnop/inject.js")).toBe("chrome-extension");
    expect(blockedOf("about:blank")).toBe("about");
  });

  it("answers unknown for nothing, and other for what is neither a URL nor a keyword", () => {
    expect(blockedOf(undefined)).toBe("unknown");
    expect(blockedOf(null)).toBe("unknown");
    expect(blockedOf(42)).toBe("unknown");
    expect(blockedOf("")).toBe("unknown");
    expect(blockedOf("not a url, just words")).toBe("other");
    expect(blockedOf("x".repeat(500))).toBe("other");
  });

  it("never lets a very long origin through whole", () => {
    expect(blockedOf(`https://${"a".repeat(300)}.example/x`).length).toBeLessThanOrEqual(200);
  });
});

describe("pathOf", () => {
  it("keeps the document's pathname and drops the query and fragment", () => {
    expect(pathOf("https://4rcos.com/")).toBe("/");
    expect(pathOf("https://4rcos.com/badge/x?owner=0xabc&secret=1#top")).toBe("/badge/x");
    expect(pathOf("http://localhost:3000/api/pulse?x=1")).toBe("/api/pulse");
  });

  it("replaces a full address in the path, since a visitor may have looked up their own", () => {
    expect(pathOf("https://4rcos.com/t/0x1111111111111111111111111111111111111111")).toBe("/t/[address]");
    expect(pathOf("https://4rcos.com/badge/0xAbCdEf0123456789aBcDeF0123456789abcdef01")).toBe("/badge/[address]");
    // A path that only looks a little like one is left as it is.
    expect(pathOf("https://4rcos.com/t/0x12")).toBe("/t/0x12");
  });

  it("answers unknown for anything that isn't an http(s) document URL", () => {
    for (const v of [undefined, null, 5, "", "about:blank", "inline", "/relative?x=1", "not a url", "data:text/html,hi", "chrome-extension://x/y"]) {
      expect(pathOf(v), String(v)).toBe("unknown");
    }
  });

  it("cuts a very long path", () => {
    expect(pathOf(`https://4rcos.com/${"a".repeat(500)}`).length).toBeLessThanOrEqual(200);
  });
});

describe("violationsFrom, application/csp-report", () => {
  const report = (fields: Record<string, unknown>) => ({ "csp-report": fields });

  it("reads the one violation in {\"csp-report\": {...}}", () => {
    expect(
      violationsFrom("application/csp-report", report({
        "document-uri": "https://4rcos.com/t/abc?x=1",
        "violated-directive": "img-src 'self'",
        "effective-directive": "img-src",
        "blocked-uri": "https://cdn.example/logo.png?v=2",
      })),
    ).toEqual([{ directive: "img-src", blocked: "https://cdn.example", path: "/t/abc" }]);
  });

  it("falls back to violated-directive when there is no effective-directive", () => {
    expect(
      violationsFrom("application/csp-report", report({
        "document-uri": "https://4rcos.com/",
        "violated-directive": "script-src 'self' 'unsafe-inline'",
        "blocked-uri": "inline",
      })),
    ).toEqual([{ directive: "script-src", blocked: "inline", path: "/" }]);
  });

  it("reads nothing from a body that isn't an object with a csp-report object", () => {
    for (const body of [null, undefined, 1, "x", [], [report({})], {}, { "csp-report": null }, { "csp-report": "x" }, { "csp-report": [] }]) {
      expect(violationsFrom("application/csp-report", body), JSON.stringify(body)).toEqual([]);
    }
  });

  it("reports a violation with only some fields as unknown for the rest, and ignores one with none", () => {
    expect(violationsFrom("application/csp-report", report({ "blocked-uri": "inline" }))).toEqual([
      { directive: "unknown", blocked: "inline", path: "unknown" },
    ]);
    expect(violationsFrom("application/csp-report", report({}))).toEqual([]);
    expect(violationsFrom("application/csp-report", report({ "blocked-uri": 1, "document-uri": [], "violated-directive": {} }))).toEqual([]);
  });

  it("takes the type as the header sends it: any case, with parameters", () => {
    const body = report({ "document-uri": "https://4rcos.com/", "effective-directive": "img-src", "blocked-uri": "data" });
    for (const type of ["Application/CSP-Report", "application/csp-report; charset=utf-8", " application/csp-report ;x=y"]) {
      expect(violationsFrom(type, body), type).toEqual([{ directive: "img-src", blocked: "data", path: "/" }]);
    }
  });
});

describe("violationsFrom, application/reports+json", () => {
  const violation = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "csp-violation",
    age: 10,
    url: "https://4rcos.com/?a=b",
    user_agent: "Mozilla/5.0 (test)",
    body,
    ...extra,
  });

  it("reads each csp-violation in the array, in order", () => {
    expect(
      violationsFrom("application/reports+json", [
        violation({ documentURL: "https://4rcos.com/?a=b", effectiveDirective: "connect-src", blockedURL: "https://x.example/p?q=1" }),
        violation({ documentURL: "https://4rcos.com/api/pulse", effectiveDirective: "script-src-elem", blockedURL: "inline" }),
      ]),
    ).toEqual([
      { directive: "connect-src", blocked: "https://x.example", path: "/" },
      { directive: "script-src-elem", blocked: "inline", path: "/api/pulse" },
    ]);
  });

  it("skips every report whose type isn't csp-violation", () => {
    const out = violationsFrom("application/reports+json", [
      { type: "deprecation", url: "https://4rcos.com/", body: { id: "x" } },
      { type: "network-error", url: "https://4rcos.com/", body: {} },
      violation({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: "data" }),
      { url: "https://4rcos.com/", body: {} },
      null,
      "junk",
      7,
    ]);
    expect(out).toEqual([{ directive: "img-src", blocked: "data", path: "/" }]);
  });

  it("uses the report's own url when the body has no documentURL, and violatedDirective when there is no effectiveDirective", () => {
    expect(
      violationsFrom("application/reports+json", [violation({ violatedDirective: "font-src 'self'", blockedURL: "https://f.example/f.woff2" })]),
    ).toEqual([{ directive: "font-src", blocked: "https://f.example", path: "/" }]);
  });

  it("reads at most ten violations from one request", () => {
    const many = Array.from({ length: 25 }, () =>
      violation({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: "data" }),
    );
    expect(violationsFrom("application/reports+json", many)).toHaveLength(10);
  });

  it("reads nothing from a body that isn't an array", () => {
    for (const body of [null, undefined, 1, "x", {}, { type: "csp-violation", body: {} }, { "csp-report": {} }]) {
      expect(violationsFrom("application/reports+json", body), JSON.stringify(body)).toEqual([]);
    }
  });

  it("reads what a csp-violation with a thin body has, and nothing from one with no usable field", () => {
    expect(violationsFrom("application/reports+json", [{ type: "csp-violation", url: "https://4rcos.com/x?y=1" }])).toEqual([
      { directive: "unknown", blocked: "unknown", path: "/x" },
    ]);
    expect(violationsFrom("application/reports+json", [{ type: "csp-violation" }])).toEqual([]);
    expect(violationsFrom("application/reports+json", [{ type: "csp-violation", body: "text" }])).toEqual([]);
    expect(violationsFrom("application/reports+json", [{ type: "csp-violation", body: [1, 2] }])).toEqual([]);
  });
});

describe("violationsFrom, any other type", () => {
  it("reads nothing, whatever the body holds", () => {
    const body = { "csp-report": { "document-uri": "https://4rcos.com/", "blocked-uri": "inline", "violated-directive": "img-src" } };
    for (const type of ["application/json", "text/plain", "", "application/x-www-form-urlencoded", "application/csp-report2"]) {
      expect(violationsFrom(type, body), type).toEqual([]);
    }
  });
});
