import path from "node:path";
import type { NextConfig } from "next";

/**
 * The generated Prisma client loads its query engine by a path computed at runtime, which Next's file
 * tracing cannot follow; force the Linux engine library and the schema it was generated from into every
 * server trace so the standalone output runs on its own (docker/web/Dockerfile). Relative to apps/web.
 */
const PRISMA_CLIENT_DIR = "../../node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A self-contained server (`.next/standalone/apps/web/server.js`) for the long-running web service.
  // Tracing starts at the monorepo root so workspace packages and pnpm's node_modules are included.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  outputFileTracingIncludes: {
    "/**": [`${PRISMA_CLIENT_DIR}/libquery_engine-*.so.node`, `${PRISMA_CLIENT_DIR}/schema.prisma`],
  },
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@clockoff/shared", "@clockoff/validation", "@clockoff/db"],
  serverExternalPackages: ["@prisma/client", "@node-rs/argon2", "pino"],
  eslint: {
    // Linting runs as its own CI step (`pnpm lint`); don't duplicate it in `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
