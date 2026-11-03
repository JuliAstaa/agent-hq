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
  ...(isStatic
    ? // Output goes to out/. Note: the export still uses .next for intermediate files, so it replaces the server
      // build there; run `npm run build` again before `npm start` (distDir only renames out/ in Next 16).
      { output: "export" as const, pageExtensions: ["tsx"] }
    : {
        // Prototype URLs (references/server.js) keep working on the same port: /hook, /event, /stream and
        // /health are served by the /api routes. Rewrites are internal (no proxy hop), so SSE on /stream
        // streams like /api/stream. Static exports cannot rewrite, hence only in the server build.
        async rewrites() {
          return [
            { source: "/hook", destination: "/api/hook" },
            { source: "/event", destination: "/api/event" },
            { source: "/stream", destination: "/api/stream" },
            { source: "/health", destination: "/api/health" },
            { source: "/agents", destination: "/api/agents" }, // not in the prototype: agent list for renames
          ];
        },
      }),
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
