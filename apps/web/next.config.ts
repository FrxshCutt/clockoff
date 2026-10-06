import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@workmode/shared", "@workmode/validation", "@workmode/db"],
  serverExternalPackages: ["@prisma/client", "@node-rs/argon2", "pino"],
  eslint: {
    // Linting runs as its own CI step (`pnpm lint`); don't duplicate it in `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
