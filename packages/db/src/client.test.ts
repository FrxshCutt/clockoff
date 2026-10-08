import { afterEach, describe, expect, it, vi } from "vitest";

describe("prisma singleton", () => {
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.NODE_ENV = previousNodeEnv;
    await globalThis.__clockoffPrisma?.$disconnect();
    globalThis.__clockoffPrisma = undefined;
    vi.resetModules();
  });

  it("is cached on globalThis in production, so separately loaded module copies share one client", async () => {
    process.env.NODE_ENV = "production";
    globalThis.__clockoffPrisma = undefined;

    vi.resetModules();
    const first = await import("./client");
    vi.resetModules();
    const second = await import("./client");

    expect(second.prisma).toBe(first.prisma);
    expect(globalThis.__clockoffPrisma).toBe(first.prisma);
  });

  it("is cached outside production too", async () => {
    process.env.NODE_ENV = "development";
    globalThis.__clockoffPrisma = undefined;

    vi.resetModules();
    const { prisma } = await import("./client");
    expect(globalThis.__clockoffPrisma).toBe(prisma);
  });
});
