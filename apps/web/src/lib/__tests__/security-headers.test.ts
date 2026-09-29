import { afterEach, describe, expect, it, vi } from "vitest";
import * as circleChains from "@circle-fin/app-kit/chains";
import { CHAINS } from "@arcos/chain";
import { bridgeChainOptions } from "@/apps/bridge/chains";
import nextConfig from "../../../next.config";
import { CSP_REPORT_PATH, enforcedHeaders, reportOnlyHeaders, reportOnlyPolicy } from "../security-headers";

type Header = { key: string; value: string };
const valueOf = (headers: Header[], key: string) => headers.find((h) => h.key === key)?.value;

/** A policy as directive name -> its source list, in the order written. */
function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    out[name!] = sources;
  }
  return out;
}

/** Every RPC origin the chain list names, both networks, https and wss. */
function chainRpcOrigins(): string[] {
  const origins = Object.values(CHAINS).flatMap((chain) =>
    [...chain.rpcUrls.default.http, ...(chain.rpcUrls.default.webSocket ?? [])].map((url) => new URL(url).origin),
  );
  return [...new Set(origins)];
}

describe("enforcedHeaders", () => {
  it("sets exactly these seven headers, with exactly these values", () => {
    expect(enforcedHeaders()).toEqual([
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      {
        key: "Content-Security-Policy",
        value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
      },
    ]);
  });

  it("leaves preload out of HSTS, and keeps the opener policy at allow-popups so a wallet's popup still works", () => {
    const headers = enforcedHeaders();
    expect(valueOf(headers, "Strict-Transport-Security")).not.toContain("preload");
    expect(valueOf(headers, "Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    expect(valueOf(headers, "Cross-Origin-Opener-Policy")).not.toBe("same-origin");
  });

  it("enforces only the four directives that can't break a wallet, Swap or Bridge flow", () => {
    const csp = valueOf(enforcedHeaders(), "Content-Security-Policy")!;
    expect(Object.keys(directives(csp))).toEqual(["frame-ancestors", "object-src", "base-uri", "form-action"]);
    // Nothing that limits what the page loads or calls: that part is report-only.
    expect(csp).not.toMatch(/default-src|script-src|connect-src|frame-src|img-src/);
  });

  it("names each header once", () => {
    const keys = enforcedHeaders().map((h) => h.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("reportOnlyPolicy", () => {
  const policy = reportOnlyPolicy();
  const d = directives(policy);

  it("starts from default-src 'self'", () => {
    expect(policy.startsWith("default-src 'self';")).toBe(true);
    expect(d["default-src"]).toEqual(["'self'"]);
  });

  it("lets scripts and styles be inline, because Next's bootstrap scripts have no nonce", () => {
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d["style-src"]).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
  });

  it("takes an image from itself, from data: and blob:, and from any https host", () => {
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"]);
  });

  it("takes a font from itself and from data:", () => {
    expect(d["font-src"]).toEqual(expect.arrayContaining(["'self'", "data:"]));
  });

  it("lets the page call itself and every Arc RPC origin of both networks, https and wss", () => {
    const connect = d["connect-src"]!;
    expect(connect[0]).toBe("'self'");
    expect(chainRpcOrigins().length).toBeGreaterThan(0);
    for (const origin of chainRpcOrigins()) expect(connect, origin).toContain(origin);
  });

  it("names the Arc RPC origins outright, so a change to the chain list is noticed here", () => {
    const connect = d["connect-src"]!;
    for (const origin of [
      "https://rpc.mainnet.arc.io",
      "https://rpc.blockdaemon.mainnet.arc.io",
      "https://rpc.drpc.mainnet.arc.io",
      "https://rpc.quicknode.mainnet.arc.io",
      "https://rpc.testnet.arc.io",
      "wss://rpc.testnet.arc.io",
    ]) {
      expect(connect, origin).toContain(origin);
    }
  });

  it("lets the browser read the explorers' APIs, which Finder and Inspector call from the page", () => {
    const connect = d["connect-src"]!;
    expect(connect).toContain("https://explorer.arc.io");
    expect(connect).toContain("https://explorer.testnet.arc.io");
  });

  it("lets WalletConnect's provider and Reown's modal reach the hosts they call", () => {
    const connect = d["connect-src"]!;
    for (const origin of [
      "wss://relay.walletconnect.org",
      "https://pulse.walletconnect.org",
      "https://api.web3modal.org",
    ]) {
      expect(connect, origin).toContain(origin);
    }
    // The modal's own stylesheet imports Inter from Google Fonts.
    expect(d["style-src"]).toContain("https://fonts.googleapis.com");
    expect(d["font-src"]).toContain("https://fonts.gstatic.com");
  });

  it("frames only the page WalletConnect's client checks the site against", () => {
    expect(d["frame-src"]).toEqual(["https://verify.walletconnect.org"]);
  });

  it("lets Circle's App Kit reach its API, its attestation service and the chains Bridge uses", () => {
    const connect = d["connect-src"]!;
    for (const origin of [
      "https://api.circle.com",
      "https://iris-api.circle.com",
      "https://iris-api-sandbox.circle.com",
      "https://mainnet.base.org",
      "https://ethereum-rpc.publicnode.com",
      "https://arb1.arbitrum.io",
      "https://mainnet.optimism.io",
      "https://polygon.publicnode.com",
      "https://api.avax.network",
      "https://sepolia.base.org",
      "https://ethereum-sepolia-rpc.publicnode.com",
    ]) {
      expect(connect, origin).toContain(origin);
    }
  });

  // The App Kit's viem adapter reads a chain through the RPC endpoints of Circle's own chain definitions. A newer App Kit
  // may name others, and Bridge would then fail once the policy is enforced: this is where that shows first.
  describe("Circle's chain definitions", () => {
    afterEach(() => vi.unstubAllEnvs());

    const definitions = (Object.values(circleChains) as unknown[]).filter(
      (v): v is { chain: string; rpcEndpoints: string[] } =>
        typeof v === "object" && v !== null && "chain" in v && "rpcEndpoints" in v,
    );
    const definitionOf = (chain: string) => {
      const found = definitions.find((d) => d.chain === chain);
      if (!found) throw new Error(`App Kit has no definition of ${chain}`);
      return found;
    };

    it.each(["mainnet", "testnet"] as const)("has every RPC endpoint App Kit names for the %s chains Bridge offers", (network) => {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
      const arc = network === "mainnet" ? "Arc" : "Arc_Testnet";
      const chains = [arc, ...bridgeChainOptions().map((o) => o.chain)];
      expect(chains).toHaveLength(7);
      const connect = d["connect-src"]!;
      for (const chain of chains) {
        const { rpcEndpoints } = definitionOf(chain);
        expect(rpcEndpoints.length, chain).toBeGreaterThan(0);
        for (const endpoint of rpcEndpoints) expect(connect, `${chain}: ${endpoint}`).toContain(new URL(endpoint).origin);
      }
    });
  });

  it("closes objects, the base URL, form targets and framing, and upgrades insecure requests", () => {
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["upgrade-insecure-requests"]).toEqual([]);
  });

  it("reports to the site's own endpoint, by report-uri and by report-to", () => {
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
    expect(d["report-to"]).toEqual(["csp"]);
  });

  it("names no wildcard, and no plain http or ws source", () => {
    expect(policy).not.toContain("*");
    for (const [name, sources] of Object.entries(d)) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(/^(http|ws):/);
      }
    }
  });

  it("gives every connect-src host as a bare origin", () => {
    for (const source of d["connect-src"]!.slice(1)) {
      expect(source, source).toMatch(/^(https|wss):\/\/[a-z0-9.-]+$/);
    }
    const connect = d["connect-src"]!;
    expect(new Set(connect).size, "no origin is listed twice").toBe(connect.length);
  });

  it("allows eval in development only, where React's debugging needs it", () => {
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives(reportOnlyPolicy({ dev: false }))["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives(reportOnlyPolicy({ dev: true }))["script-src"]).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
  });
});

describe("reportOnlyHeaders", () => {
  it("carries the full policy as Report-Only, and a Reporting-Endpoints header that names the csp group", () => {
    const headers = reportOnlyHeaders();
    expect(valueOf(headers, "Content-Security-Policy-Report-Only")).toBe(reportOnlyPolicy());
    expect(valueOf(headers, "Reporting-Endpoints")).toBe('csp="/api/csp-report"');
    expect(headers).toHaveLength(2);
  });

  it("never carries an enforced Content-Security-Policy, which would block what it should only report", () => {
    expect(valueOf(reportOnlyHeaders(), "Content-Security-Policy")).toBeUndefined();
    expect(valueOf(reportOnlyHeaders({ dev: true }), "Content-Security-Policy")).toBeUndefined();
  });

  it("puts nothing that could break a header line in a value", () => {
    for (const { key, value } of [...enforcedHeaders(), ...reportOnlyHeaders(), ...reportOnlyHeaders({ dev: true })]) {
      expect(`${key}: ${value}`, key).not.toMatch(/[\r\n]/);
      expect(value, key).toBe(value.trim());
    }
  });
});

describe("next.config.ts", () => {
  it("applies both header sets to every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/:path*"]);
    const applied = rules.flatMap((r) => r.headers);
    const expected = [...enforcedHeaders(), ...reportOnlyHeaders({ dev: process.env.NODE_ENV === "development" })];
    expect(applied).toEqual(expected);
  });

  it("gives no header key to two rules, since the last rule for a key would win", async () => {
    const keys = (await nextConfig.headers!()).flatMap((r) => r.headers.map((h) => h.key.toLowerCase()));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
