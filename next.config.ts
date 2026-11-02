import type { NextConfig } from "next";

// HQ_STATIC=1 builds a static demo export to out/ (no bridge, demo mode only).
// Route handlers are named route.ts, so restricting pageExtensions to tsx leaves them out of that build.
const isStatic = process.env.HQ_STATIC === "1";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  // D1: cacheComponents and partialPrefetching are off so the bridge routes can declare
  // runtime = 'nodejs' and dynamic = 'force-dynamic' (prd.md §6).
  // SSE must not be gzip-buffered (prd.md Appendix C).
  compress: false,
  env: {
    NEXT_PUBLIC_HQ_STATIC: isStatic ? "1" : "",
  },
  ...(isStatic ? { output: "export" as const, pageExtensions: ["tsx"] } : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
