import { describe, expect, it, vi } from "vitest";
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

  it("reads only the first word of a large value, without splitting the rest into words", () => {
    // A body may be 256 KB; a value of that many words must not become an array of them all.
    const value = `script-src ${"a ".repeat(128 * 1024)}`;
    const split = vi.spyOn(String.prototype, "split");
    try {
      expect(directiveOf(value)).toBe("script-src");
      for (const result of split.mock.results) {
        expect((result.value as string[]).length).toBeLessThanOrEqual(1);
      }
    } finally {
      split.mockRestore();
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

  it("replaces a full address in the origin, as it does in a path", () => {
    expect(blockedOf("https://0x1111111111111111111111111111111111111111.example/x.js")).toBe("https://[address].example");
    // The URL parser lowercases a host, so an address written in mixed case is found as well.
    expect(blockedOf("https://0xAbCdEf0123456789aBcDeF0123456789abcdef01.example/x.js")).toBe("https://[address].example");
    expect(blockedOf("wss://relay.0x1111111111111111111111111111111111111111.example:8443/socket")).toBe("wss://relay.[address].example:8443");
    // Something that only looks a little like one is left as it is.
    expect(blockedOf("https://0x1234.example/x.js")).toBe("https://0x1234.example");
  });

  it("replaces the address before it cuts a long origin, so half of one is never left at the cut", () => {
    // The 200-character cut would fall in the middle of the address: 8 for "https://", 170 for the label, 2 for "0x", 20 digits.
    const blocked = blockedOf(`https://${"a".repeat(170)}0x${"1".repeat(40)}.example/x.js`);
    expect(blocked.length).toBeLessThanOrEqual(200);
    expect(blocked).toContain("[address]");
    expect(blocked).not.toMatch(/1{4}/);
    expect(blocked).not.toContain("0x");
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

  it("reads at most ten violations from one request, the first ten different ones", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      violation({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: `https://cdn${i}.example/logo.png` }),
    );
    const out = violationsFrom("application/reports+json", many);
    expect(out).toHaveLength(10);
    expect(out.map((v) => v.blocked)).toEqual(Array.from({ length: 10 }, (_, i) => `https://cdn${i}.example`));
  });

  describe("a violation a request repeats", () => {
    const img = (blockedURL: string, extra: Record<string, unknown> = {}) =>
      violation({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL, ...extra });

    it("is read once, in the place it first appears", () => {
      const many = [...Array.from({ length: 25 }, () => img("data")), img("https://cdn.example/a.png")];
      expect(violationsFrom("application/reports+json", many)).toEqual([
        { directive: "img-src", blocked: "data", path: "/" },
        { directive: "img-src", blocked: "https://cdn.example", path: "/" },
      ]);
    });

    it("does not use up the ten, so a different violation after a noisy host's is still read", () => {
      // A font host blocked for 15 files, then a stylesheet host and a script host: 3 violations, not 10 lines of the first.
      const noisy = Array.from({ length: 15 }, (_, i) =>
        violation({ documentURL: "https://4rcos.com/", effectiveDirective: "font-src", blockedURL: `https://fonts.example/f${i}.woff2` }),
      );
      const rest = [
        violation({ documentURL: "https://4rcos.com/", effectiveDirective: "style-src-elem", blockedURL: "https://css.example/a.css" }),
        violation({ documentURL: "https://4rcos.com/", effectiveDirective: "script-src-elem", blockedURL: "https://js.example/a.js" }),
      ];
      expect(violationsFrom("application/reports+json", [...noisy, ...rest])).toEqual([
        { directive: "font-src", blocked: "https://fonts.example", path: "/" },
        { directive: "style-src-elem", blocked: "https://css.example", path: "/" },
        { directive: "script-src-elem", blocked: "https://js.example", path: "/" },
      ]);
    });

    it("is a different one when the directive, the blocked origin or the page's path differs", () => {
      const out = violationsFrom("application/reports+json", [
        img("https://cdn.example/a.png"),
        img("https://cdn.example/a.png", { effectiveDirective: "connect-src" }),
        img("https://other.example/a.png"),
        img("https://cdn.example/a.png", { documentURL: "https://4rcos.com/badge/x" }),
      ]);
      expect(out).toEqual([
        { directive: "img-src", blocked: "https://cdn.example", path: "/" },
        { directive: "connect-src", blocked: "https://cdn.example", path: "/" },
        { directive: "img-src", blocked: "https://other.example", path: "/" },
        { directive: "img-src", blocked: "https://cdn.example", path: "/badge/x" },
      ]);
    });

    it("is the same one when only what the log doesn't keep differs: the blocked file, its query, the page's query", () => {
      const out = violationsFrom("application/reports+json", [
        img("https://cdn.example/a.png"),
        img("https://cdn.example/b.png?again=1"),
        img("https://cdn.example/c/d.png#top", { documentURL: "https://4rcos.com/?ref=x" }),
        img("https://cdn.example/a.png", { sample: "different", lineNumber: 9 }),
      ]);
      expect(out).toEqual([{ directive: "img-src", blocked: "https://cdn.example", path: "/" }]);
    });

    // Chromium keeps at most 100 reports for an upload, so a longer array isn't a browser's; reading on through thousands of
    // tiny ones would only hand a caller with a 256 KB body work to make the route do.
    it("looks at the first 100 reports of an array and no further, which is all Chromium keeps for one upload", () => {
      const copies = (n: number) => Array.from({ length: n }, () => img("data"));
      const last = img("https://cdn.example/a.png");
      expect(violationsFrom("application/reports+json", [...copies(99), last])).toHaveLength(2);
      expect(violationsFrom("application/reports+json", [...copies(100), last])).toHaveLength(1);
    });

    it("is the same when two paths differ only by an address, which is not logged", () => {
      const out = violationsFrom("application/reports+json", [
        img("data", { documentURL: "https://4rcos.com/t/0x1111111111111111111111111111111111111111" }),
        img("data", { documentURL: "https://4rcos.com/t/0x2222222222222222222222222222222222222222" }),
        img("https://0x3333333333333333333333333333333333333333.example/a.png"),
        img("https://0x4444444444444444444444444444444444444444.example/b.png"),
      ]);
      expect(out).toEqual([
        { directive: "img-src", blocked: "data", path: "/t/[address]" },
        { directive: "img-src", blocked: "https://[address].example", path: "/" },
      ]);
    });
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
