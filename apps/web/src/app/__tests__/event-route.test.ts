import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/event/route";

const MAX_BODY = 2 * 1024;
const SITE = "https://4rcos.test";

const send = (
  body: BodyInit | null,
  {
    ip = "198.51.100.7",
    origin = SITE,
    host = "4rcos.test",
    headers = {},
  }: { ip?: string; origin?: string | null; host?: string | null; headers?: Record<string, string> } = {},
) =>
  POST(
    new Request(`${SITE}/api/event`, {
      method: "POST",
      headers: {
        "x-real-ip": ip,
        ...(origin === null ? {} : { origin }),
        ...(host === null ? {} : { host }),
        ...headers,
      },
      body,
    }),
  );
const sendEvent = (name: unknown, props?: unknown, options?: Parameters<typeof send>[1]) =>
  send(JSON.stringify({ name, props }), options);

let log: ReturnType<typeof vi.spyOn>;
let lines: unknown[][];
let clients = 0;
/** A client address no other test has used, so the per-client limit never carries over. */
const freshIp = () => `203.0.113.${(clients += 1)}`;
const logged = () => lines.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  lines = log.mock.calls;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/event", () => {
  it("answers 204 with nothing in the body, and writes one line of JSON on stdout for a valid event", async () => {
    const res = await sendEvent("inspect_run", { passed: 5, total: 8 }, { ip: freshIp() });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    // The exact line, so the shape and the order of its keys are pinned: Cloud Run reads it as a structured log entry.
    expect(lines[0]![0]).toBe('{"severity":"INFO","message":"event","event":"inspect_run","passed":5,"total":8}');
  });

  it("counts each of the nine events with its own props", async () => {
    const ip = freshIp();
    await sendEvent("inspect_run", { passed: 3, total: 8 }, { ip });
    await sendEvent("fix_click", { app: "vault" }, { ip });
    await sendEvent("proof_share", {}, { ip });
    await sendEvent("mint_success", { mintable: 1, burnable: 0 }, { ip });
    await sendEvent("drop_success", { recipients: 50, batches: 1 }, { ip });
    await sendEvent("swap_success", { pair: "USDC-EURC" }, { ip });
    await sendEvent("bridge_success", { from: "Base", to: "Arc" }, { ip });
    await sendEvent("revoke_success", undefined, { ip });
    await sendEvent("terminal_run", { command: "balance" }, { ip });
    expect(logged()).toEqual([
      { severity: "INFO", message: "event", event: "inspect_run", passed: 3, total: 8 },
      { severity: "INFO", message: "event", event: "fix_click", app: "vault" },
      { severity: "INFO", message: "event", event: "proof_share" },
      { severity: "INFO", message: "event", event: "mint_success", mintable: 1, burnable: 0 },
      { severity: "INFO", message: "event", event: "drop_success", recipients: 50, batches: 1 },
      { severity: "INFO", message: "event", event: "swap_success", pair: "USDC-EURC" },
      { severity: "INFO", message: "event", event: "bridge_success", from: "Base", to: "Arc" },
      { severity: "INFO", message: "event", event: "revoke_success" },
      { severity: "INFO", message: "event", event: "terminal_run", command: "balance" },
    ]);
  });

  it("drops a prop that fails and still counts the event", async () => {
    await sendEvent("drop_success", { recipients: -5, batches: 2, wallet: "0x1111111111111111111111111111111111111111" }, { ip: freshIp() });
    await sendEvent("swap_success", { pair: "not valid!" }, { ip: freshIp() });
    expect(logged()).toEqual([
      { severity: "INFO", message: "event", event: "drop_success", batches: 2 },
      { severity: "INFO", message: "event", event: "swap_success" },
    ]);
  });

  it("counts a name that isn't in the list as nothing, and answers 204 all the same", async () => {
    for (const name of ["nope", "", "__proto__", "constructor", 5, null]) {
      const res = await sendEvent(name, { passed: 1 }, { ip: freshIp() });
      expect(res.status, String(name)).toBe(204);
    }
    expect(lines).toHaveLength(0);
  });

  it("writes nothing about the client: no address, no user agent, no cookie, no referrer", async () => {
    await sendEvent("inspect_run", { passed: 5, total: 8 }, {
      ip: "198.51.100.99",
      headers: {
        "x-forwarded-for": "192.0.2.55, 198.51.100.99",
        "user-agent": "Mozilla/5.0 UNIQUE-UA-STRING",
        cookie: "session=abc",
        referer: "https://4rcos.test/t/0x1111111111111111111111111111111111111111?wallet=1",
        authorization: "Bearer secret-token",
      },
    });
    expect(lines).toHaveLength(1);
    const everything = JSON.stringify(log.mock.calls);
    for (const leak of ["198.51.100", "192.0.2.55", "UNIQUE-UA-STRING", "session=abc", "0x1111", "wallet", "secret-token", "4rcos.test"]) {
      expect(everything, leak).not.toContain(leak);
    }
  });

  it("lets no wallet address through as a prop: an address is longer than a value may be", async () => {
    const wallet = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
    for (const [name, props] of [
      ["fix_click", { app: wallet }],
      ["swap_success", { pair: wallet }],
      ["bridge_success", { from: wallet, to: wallet }],
      ["terminal_run", { command: wallet }],
    ] as const) {
      await sendEvent(name, props, { ip: freshIp() });
    }
    expect(lines).toHaveLength(4);
    expect(JSON.stringify(log.mock.calls)).not.toContain(wallet);
    expect(JSON.stringify(log.mock.calls)).not.toContain("0xAbCd");
  });

  it("writes through console.log alone, as one line", async () => {
    await sendEvent("fix_click", { app: "vault" }, { ip: freshIp() });
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(String(lines[0]![0]).split("\n")).toHaveLength(1);
  });

  it("takes a body of any content type, since a beacon of text sends text/plain", async () => {
    const body = JSON.stringify({ name: "proof_share", props: {} });
    for (const type of ["text/plain;charset=UTF-8", "application/json", "application/x-www-form-urlencoded", ""]) {
      await send(body, { ip: freshIp(), headers: type ? { "content-type": type } : {} });
    }
    expect(lines).toHaveLength(4);
  });

  describe("the size cap", () => {
    /** An inspect_run body padded, through an ignored field, to `bytes` bytes exactly. */
    const padded = (bytes: number) => {
      const base = JSON.stringify({ name: "inspect_run", props: { passed: 1 }, pad: "" });
      return JSON.stringify({ name: "inspect_run", props: { passed: 1 }, pad: "a".repeat(bytes - Buffer.byteLength(base)) });
    };

    it("reads a body of exactly 2 KB", async () => {
      const body = padded(MAX_BODY);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY);
      const res = await send(body, { ip: freshIp() });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(1);
    });

    it("ignores a body of one byte more, and answers 204", async () => {
      const body = padded(MAX_BODY + 1);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY + 1);
      const res = await send(body, { ip: freshIp() });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(0);
    });

    it("ignores a body whose content-length says it is over, without reading it", async () => {
      const res = await sendEvent("proof_share", {}, { ip: freshIp(), headers: { "content-length": String(MAX_BODY + 1) } });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(0);
    });
  });

  describe("the origin", () => {
    it("counts a request from the site's own origin, and one with no Origin at all", async () => {
      await sendEvent("proof_share", {}, { ip: freshIp(), origin: SITE });
      await sendEvent("proof_share", {}, { ip: freshIp(), origin: null });
      expect(lines).toHaveLength(2);
    });

    it("ignores another site's origin, and answers 204", async () => {
      for (const origin of ["https://evil.example", "https://4rcos.test.evil.example", "https://4rcos.com", "http://localhost:3000", "null"]) {
        const res = await sendEvent("proof_share", {}, { ip: freshIp(), origin });
        expect(res.status, origin).toBe(204);
      }
      expect(lines).toHaveLength(0);
    });

    it("counts the host the site is reached on behind a proxy that forwards it, and the site's own address", async () => {
      // Firebase's front end hands Cloud Run its own host and the visitor's in x-forwarded-host.
      await sendEvent("proof_share", {}, {
        ip: freshIp(),
        origin: "https://4rcos.com",
        host: "arcos-abc.a.run.app",
        headers: { "x-forwarded-host": "4rcos.com" },
      });
      expect(lines).toHaveLength(1);
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://4rcos.com");
      await sendEvent("proof_share", {}, { ip: freshIp(), origin: "https://4rcos.com", host: "internal.local:8080" });
      expect(lines).toHaveLength(2);
      // Still not another site's, with the site's address set.
      await sendEvent("proof_share", {}, { ip: freshIp(), origin: "https://evil.example", host: "internal.local:8080" });
      expect(lines).toHaveLength(2);
    });
  });

  describe("junk", () => {
    it("answers 204 and writes nothing for a body that isn't JSON, is empty, or holds the wrong shape", async () => {
      const ip = freshIp();
      for (const body of [null, "", "not json", "{", "null", "42", '"inspect_run"', "[]", "{}", '{"name":5}', '{"props":{}}', '[{"name":"inspect_run"}]']) {
        const res = await send(body, { ip });
        expect(res.status, String(body)).toBe(204);
        expect(await res.text()).toBe("");
      }
      expect(lines).toHaveLength(0);
    });

    it("never echoes anything back: no body, no content type", async () => {
      const res = await sendEvent("fix_click", { app: "echo-me" }, { ip: freshIp() });
      expect(await res.text()).toBe("");
      expect(res.headers.get("content-type")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("the per-client limit", () => {
    it("counts the first 120 events from one client in a minute, then answers 204 and counts nothing", async () => {
      const client = freshIp();
      for (let i = 0; i < 120; i++) expect((await sendEvent("proof_share", {}, { ip: client })).status).toBe(204);
      expect(lines).toHaveLength(120);
      const res = await sendEvent("proof_share", {}, { ip: client });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(lines).toHaveLength(120);
    });

    it("keeps each client's count to itself", async () => {
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < 121; i++) await sendEvent("proof_share", {}, { ip: a });
      const before = lines.length;
      await sendEvent("proof_share", {}, { ip: b });
      expect(lines).toHaveLength(before + 1);
    });

    it("doesn't spend a client's allowance on a request from another site", async () => {
      const client = freshIp();
      for (let i = 0; i < 200; i++) await sendEvent("proof_share", {}, { ip: client, origin: "https://evil.example" });
      const res = await sendEvent("proof_share", {}, { ip: client });
      expect(res.status).toBe(204);
      expect(lines).toHaveLength(1);
    });
  });
});
