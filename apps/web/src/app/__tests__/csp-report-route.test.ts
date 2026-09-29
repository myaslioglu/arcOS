import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/csp-report/route";
import { reportOnlyPolicy } from "@/lib/security-headers";

const MAX_BODY = 256 * 1024;

const legacy = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    "csp-report": {
      "document-uri": "https://4rcos.com/",
      "violated-directive": "img-src",
      "effective-directive": "img-src",
      "blocked-uri": "https://cdn.example/logo.png",
      ...fields,
    },
  });

const reports = (...bodies: Record<string, unknown>[]) =>
  JSON.stringify(bodies.map((body) => ({ type: "csp-violation", age: 5, url: "https://4rcos.com/", user_agent: "test-agent", body })));

const send = (
  body: BodyInit | null,
  { type = "application/csp-report", ip = "198.51.100.7", headers = {} }: { type?: string | null; ip?: string; headers?: Record<string, string> } = {},
) =>
  POST(
    new Request("https://4rcos.test/api/csp-report", {
      method: "POST",
      headers: { ...(type === null ? {} : { "content-type": type }), "x-real-ip": ip, ...headers },
      body,
    }),
  );

let lines: unknown[][];
let warn: ReturnType<typeof vi.spyOn>;
let ip = 0;
/** A client address no other test has used, so the per-client limit never carries over. */
const freshIp = () => `203.0.113.${(ip += 1)}`;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  lines = warn.mock.calls;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const logged = () => lines.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

describe("POST /api/csp-report", () => {
  it("answers 204 with nothing in the body, and writes one JSON line for a legacy application/csp-report", async () => {
    const res = await send(legacy(), { ip: freshIp() });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    expect(typeof lines[0]![0]).toBe("string");
    expect(String(lines[0]![0])).not.toContain("\n");
    expect(logged()).toEqual([
      { severity: "WARNING", message: "csp-violation", directive: "img-src", blocked: "https://cdn.example", path: "/" },
    ]);
  });

  it("reads application/reports+json: one line for each csp-violation in the array, none for other kinds", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", url: "https://4rcos.com/", body: { documentURL: "https://4rcos.com/", effectiveDirective: "connect-src", blockedURL: "https://api.x.example/v1?q=1" } },
      { type: "deprecation", url: "https://4rcos.com/", body: { id: "PrefixedStorageInfo" } },
      { type: "csp-violation", url: "https://4rcos.com/api/pulse", body: { documentURL: "https://4rcos.com/api/pulse", effectiveDirective: "script-src-elem", blockedURL: "inline" } },
    ]);
    const res = await send(body, { type: "application/reports+json", ip: freshIp() });
    expect(res.status).toBe(204);
    expect(logged()).toEqual([
      { severity: "WARNING", message: "csp-violation", directive: "connect-src", blocked: "https://api.x.example", path: "/" },
      { severity: "WARNING", message: "csp-violation", directive: "script-src-elem", blocked: "inline", path: "/api/pulse" },
    ]);
  });

  it("takes a content type written with a parameter or in another case", async () => {
    await send(legacy(), { type: "application/csp-report; charset=utf-8", ip: freshIp() });
    await send(reports({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: "data" }), {
      type: "Application/Reports+JSON",
      ip: freshIp(),
    });
    expect(lines).toHaveLength(2);
  });

  it("writes the keyword a browser reports, and the origin only for a URL", async () => {
    const ipAddress = freshIp();
    await send(legacy({ "blocked-uri": "eval", "effective-directive": "script-src" }), { ip: ipAddress });
    await send(legacy({ "blocked-uri": "data", "effective-directive": "img-src" }), { ip: ipAddress });
    await send(legacy({ "blocked-uri": "wss://relay.example.org/x?token=abc", "effective-directive": "connect-src" }), { ip: ipAddress });
    expect(logged().map((l) => [l.directive, l.blocked])).toEqual([
      ["script-src", "eval"],
      ["img-src", "data"],
      ["connect-src", "wss://relay.example.org"],
    ]);
  });

  it("never lets a query string reach the log, from any field of either format", async () => {
    const secret = "SECRET-QUERY-VALUE";
    const wallet = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
    const url = (path: string) => `https://4rcos.com${path}?wallet=${wallet}&token=${secret}#${secret}`;
    await send(
      legacy({
        "document-uri": url("/t/page"),
        "blocked-uri": url("/asset.js"),
        referrer: url("/from"),
        "source-file": url("/bundle.js"),
        "script-sample": `alert("${secret}")`,
        "original-policy": `default-src 'self'; report-uri /api/csp-report?x=${secret}`,
      }),
      { ip: freshIp() },
    );
    await send(
      reports({
        documentURL: url("/t/page"),
        blockedURL: url("/asset.js"),
        referrer: url("/from"),
        sourceFile: url("/bundle.js"),
        sample: `alert("${secret}")`,
        originalPolicy: `default-src 'self'; report-uri /api/csp-report?x=${secret}`,
        effectiveDirective: "script-src-elem",
      }),
      { type: "application/reports+json", ip: freshIp() },
    );
    expect(lines).toHaveLength(2);
    const everything = JSON.stringify(warn.mock.calls);
    for (const leak of [secret, wallet, wallet.toLowerCase(), "wallet=", "token=", "?", "#", "bundle.js", "asset.js", "/from"]) {
      expect(everything, leak).not.toContain(leak);
    }
    expect(logged()).toEqual([
      { severity: "WARNING", message: "csp-violation", directive: "img-src", blocked: "https://4rcos.com", path: "/t/page" },
      { severity: "WARNING", message: "csp-violation", directive: "script-src-elem", blocked: "https://4rcos.com", path: "/t/page" },
    ]);
  });

  it("writes no address of the visitor's from the path either", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    await send(legacy({ "document-uri": `https://4rcos.com/t/${wallet}?a=1` }), { ip: freshIp() });
    expect(logged()[0]!.path).toBe("/t/[address]");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(wallet);
  });

  it("writes nothing about the client: no address, no user agent, no header", async () => {
    await send(legacy(), {
      ip: "198.51.100.99",
      headers: {
        "x-forwarded-for": "192.0.2.55, 198.51.100.99",
        "user-agent": "Mozilla/5.0 UNIQUE-UA-STRING",
        cookie: "session=abc",
        referer: "https://elsewhere.example/page?x=1",
      },
    });
    await send(reports({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: "data" }), {
      type: "application/reports+json",
      ip: "198.51.100.98",
      headers: { "user-agent": "Mozilla/5.0 UNIQUE-UA-STRING" },
    });
    const everything = JSON.stringify(warn.mock.calls);
    for (const leak of ["198.51.100", "192.0.2.55", "UNIQUE-UA-STRING", "test-agent", "session=abc", "elsewhere.example"]) {
      expect(everything, leak).not.toContain(leak);
    }
    expect(lines).toHaveLength(2);
  });

  it("writes only through console.warn, as one string of one line of JSON", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    await send(legacy({ "blocked-uri": "https://a.example/x\ninjected line" }), { ip: freshIp() });
    expect(lines).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(String(lines[0]![0]).split("\n")).toHaveLength(1);
  });

  it("writes at most ten lines for one request, when its violations are all different", async () => {
    const distinct = (i: number) => ({ documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: `https://cdn${i}.example/logo.png` });
    await send(reports(...Array.from({ length: 40 }, (_, i) => distinct(i))), { type: "application/reports+json", ip: freshIp() });
    expect(lines).toHaveLength(10);
    expect(logged().map((l) => l.blocked)).toEqual(Array.from({ length: 10 }, (_, i) => `https://cdn${i}.example`));
  });

  it("writes one line for a violation a request repeats", async () => {
    const one = { documentURL: "https://4rcos.com/", effectiveDirective: "img-src", blockedURL: "data" };
    await send(reports(...Array.from({ length: 40 }, () => one)), { type: "application/reports+json", ip: freshIp() });
    expect(logged()).toEqual([{ severity: "WARNING", message: "csp-violation", directive: "img-src", blocked: "data", path: "/" }]);
  });

  // What Chromium sends for a report-only policy: the Reporting API's array, each report with the whole policy in
  // `originalPolicy` (about 1.4 KB), next to the few fields the log reads. Its cache keeps up to 100 reports for one upload.
  describe("a batch as Chromium sends it", () => {
    const chromiumReport = (blockedURL: string, effectiveDirective: string) => ({
      age: 0,
      body: {
        blockedURL,
        columnNumber: 5,
        disposition: "report",
        documentURL: "https://4rcos.com/",
        effectiveDirective,
        lineNumber: 2,
        originalPolicy: reportOnlyPolicy(),
        referrer: "",
        sample: "",
        statusCode: 200,
      },
      type: "csp-violation",
      url: "https://4rcos.com/",
      user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    });
    const line = (directive: string, blocked: string) => ({ severity: "WARNING", message: "csp-violation", directive, blocked, path: "/" });

    it("takes 30 reports that each carry the whole policy, about 55 KB, which the old 16 KB cap dropped whole", async () => {
      const body = JSON.stringify(Array.from({ length: 30 }, (_, i) => chromiumReport(`https://cdn${i}.example/x.js?n=${i}`, "script-src-elem")));
      expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
      expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY);
      const res = await send(body, { type: "application/reports+json", ip: freshIp() });
      expect(res.status).toBe(204);
      expect(logged()).toEqual(Array.from({ length: 10 }, (_, i) => line("script-src-elem", `https://cdn${i}.example`)));
    });

    it("takes the most Chromium keeps for one upload, 100 reports, so a policy that grows past that fails here first", async () => {
      const body = JSON.stringify(Array.from({ length: 100 }, (_, i) => chromiumReport(`https://cdn${i}.example/x.js`, "script-src-elem")));
      expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY);
      const res = await send(body, { type: "application/reports+json", ip: freshIp() });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(10);
    });

    it("keeps a noisy host's repeats from hiding a different violation later in the same batch", async () => {
      // A page that blocks 28 font files raises 28 reports that differ only in the file, which the log doesn't keep.
      const fonts = Array.from({ length: 28 }, (_, i) => chromiumReport(`https://fonts.gstatic.com/s/inter/v${i}/file.woff2`, "font-src"));
      const body = JSON.stringify([...fonts, chromiumReport("https://fonts.googleapis.com/css2?family=Inter", "style-src-elem")]);
      const res = await send(body, { type: "application/reports+json", ip: freshIp() });
      expect(res.status).toBe(204);
      expect(logged()).toEqual([line("font-src", "https://fonts.gstatic.com"), line("style-src-elem", "https://fonts.googleapis.com")]);
    });
  });

  describe("the size cap", () => {
    /** A legacy report padded to `bytes` bytes exactly. */
    const padded = (bytes: number) => {
      const base = legacy({ "script-sample": "" });
      return legacy({ "script-sample": "a".repeat(bytes - Buffer.byteLength(base)) });
    };

    it("reads a body of exactly 256 KB", async () => {
      const body = padded(MAX_BODY);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY);
      const res = await send(body, { ip: freshIp() });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(1);
    });

    it("ignores a body of one byte more, and still answers 204", async () => {
      const body = padded(MAX_BODY + 1);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY + 1);
      const res = await send(body, { ip: freshIp() });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(lines).toHaveLength(0);
    });

    it("ignores a body whose content-length says it is over, without reading it", async () => {
      const res = await send(legacy(), { ip: freshIp(), headers: { "content-length": String(MAX_BODY + 1) } });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(0);
    });

    it("ignores a body that is far over the cap", async () => {
      const res = await send(padded(10 * MAX_BODY), { ip: freshIp() });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(0);
    });
  });

  describe("junk", () => {
    it("answers 204 and writes nothing for a body that isn't JSON, is empty, or holds the wrong shape", async () => {
      const ipAddress = freshIp();
      const bodies: (string | null)[] = [
        null,
        "",
        "not json",
        "{",
        "null",
        "42",
        '"csp-report"',
        "[]",
        "{}",
        '{"csp-report":null}',
        '{"csp-report":[]}',
        '{"csp-report":{}}',
        '[{"type":"csp-violation"}]',
        '{"type":"csp-violation","body":{"blockedURL":"inline"}}',
      ];
      for (const body of bodies) {
        for (const type of ["application/csp-report", "application/reports+json"]) {
          const res = await send(body, { type, ip: ipAddress });
          expect(res.status, `${type} ${body}`).toBe(204);
          expect(await res.text()).toBe("");
        }
      }
      expect(lines).toHaveLength(0);
    });

    it("answers 204 and writes nothing for a type that is neither of the two, or none at all", async () => {
      for (const type of ["application/json", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "", null]) {
        const res = await send(legacy(), { type, ip: freshIp() });
        expect(res.status, String(type)).toBe(204);
      }
      expect(lines).toHaveLength(0);
    });

    it("answers 204 when a report holds values of the wrong kind", async () => {
      const res = await send(
        legacy({ "document-uri": { a: 1 }, "blocked-uri": ["x"], "effective-directive": 5, "violated-directive": {} }),
        { ip: freshIp() },
      );
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(0);
    });

    it("never echoes anything back: no body, no content type", async () => {
      const res = await send(legacy({ "blocked-uri": "https://echo.example/" }), { ip: freshIp() });
      expect(await res.text()).toBe("");
      expect(res.headers.get("content-type")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("the per-client limit", () => {
    it("writes for the first 60 reports from one client in a minute, then answers 204 and writes nothing", async () => {
      const client = freshIp();
      for (let i = 0; i < 60; i++) expect((await send(legacy(), { ip: client })).status).toBe(204);
      expect(lines).toHaveLength(60);
      const res = await send(legacy(), { ip: client });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(lines).toHaveLength(60);
    });

    it("keeps each client's count to itself", async () => {
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < 61; i++) await send(legacy(), { ip: a });
      const before = lines.length;
      await send(legacy(), { ip: b });
      expect(lines).toHaveLength(before + 1);
    });
  });
});
