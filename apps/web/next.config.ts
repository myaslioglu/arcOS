import type { NextConfig } from "next";
import { activeNetwork } from "@arcos/chain";
import { robotsHeaders } from "./src/lib/site";
import { enforcedHeaders, reportOnlyHeaders } from "./src/lib/security-headers";

/** The Inspector's routes that take a chain before the address: /t, /badge and /api/inspect. */
const INSPECT_ROUTES = ["t", "badge", "api/inspect"] as const;

const nextConfig: NextConfig = {
  transpilePackages: ["@arcos/shell", "@arcos/chain", "@arcos/inspector", "@arcos/data"],
  // The security headers of every answer: the enforced set, and the full content security policy in report-only mode
  // (src/lib/security-headers.ts). Different header names, so neither rule overrides the other. On the testnet site only,
  // X-Robots-Tag keeps every answer out of search engines (src/lib/site.ts).
  async headers() {
    const robots = robotsHeaders(activeNetwork());
    return [
      { source: "/:path*", headers: enforcedHeaders() },
      { source: "/:path*", headers: reportOnlyHeaders({ dev: process.env.NODE_ENV === "development" }) },
      ...(robots.length > 0 ? [{ source: "/:path*", headers: robots }] : []),
    ];
  },
  // Arc's reports live at the bare address for good (badges are embedded on other sites), so Arc's slug in the chain form
  // is sent there for good too: a 308, before any route runs (src/lib/inspect-route.ts).
  async redirects() {
    return INSPECT_ROUTES.map((route) => ({ source: `/${route}/arc/:address`, destination: `/${route}/:address`, permanent: true }));
  },
};

export default nextConfig;
