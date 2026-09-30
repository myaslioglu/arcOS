import type { NextConfig } from "next";
import { activeNetwork } from "@arcos/chain";
import { robotsHeaders } from "./src/lib/site";
import { enforcedHeaders, reportOnlyHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  transpilePackages: ["@arcos/shell", "@arcos/chain", "@arcos/inspector"],
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
};

export default nextConfig;
