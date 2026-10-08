import { PrismaClient } from "@prisma/client";

declare global {
  var __clockoffPrisma: PrismaClient | undefined;
}

/**
 * Prisma client singleton, cached on `globalThis` in every environment:
 * - Next.js dev hot-reloading would otherwise create a new connection pool on every reload;
 * - in production Next.js bundles this module into separate webpack layers (the instrumentation hook and
 *   the route handlers), each with its own module state, so the cache also dedupes the client across
 *   those layers and the web process runs one query engine and one connection pool.
 */
export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  return new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalThis.__clockoffPrisma ?? createPrismaClient();

globalThis.__clockoffPrisma = prisma;
