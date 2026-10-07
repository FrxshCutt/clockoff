import { PrismaClient } from "@prisma/client";

declare global {
  var __clockoffPrisma: PrismaClient | undefined;
}

/**
 * Prisma client singleton. Next.js dev hot-reloading would otherwise create a new
 * connection pool on every reload, so the instance is cached on `globalThis`.
 */
export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  return new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalThis.__clockoffPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__clockoffPrisma = prisma;
}
