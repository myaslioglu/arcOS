import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@arcos/shell", "@arcos/chain", "@arcos/inspector"],
};

export default nextConfig;
