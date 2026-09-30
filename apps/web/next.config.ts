import type { NextConfig } from "next";
import { enforcedHeaders, reportOnlyHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  transpilePackages: ["@arcos/shell", "@arcos/chain", "@arcos/inspector", "@arcos/data"],
  // The security headers of every answer: the enforced set, and the full content security policy in report-only mode
  // (src/lib/security-headers.ts). Different header names, so neither rule overrides the other.
  async headers() {
    return [
      { source: "/:path*", headers: enforcedHeaders() },
      { source: "/:path*", headers: reportOnlyHeaders({ dev: process.env.NODE_ENV === "development" }) },
    ];
  },
};

export default nextConfig;
