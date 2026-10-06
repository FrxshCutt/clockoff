/**
 * Vitest setupFile for the `integration` project: runs in the test worker before every test file.
 *
 * 1. Points the app at the test database. `@workmode/db` creates its Prisma singleton from
 *    `process.env.DATABASE_URL` the first time it is imported, so DATABASE_URL is replaced with
 *    TEST_DATABASE_URL here, before any module that imports `@workmode/db` is loaded (static imports in
 *    this file are deliberately limited to modules that do not touch the database).
 * 2. Pins a deterministic test environment: NODE_ENV=test (logs silent unless TEST_LOG_LEVEL is set),
 *    email verification off unless a test turns it on, console email / memory rate-limit backends.
 * 3. Installs in-memory test doubles: MockEmailProvider (tests read verification / reset / invite
 *    tokens from it), a fresh MemoryRateLimiter and InProcessEventBus before each test, and waits for
 *    background tasks (`runAfterResponse`) after each test so none leaks into the next.
 */
import { afterAll, afterEach, beforeEach } from "vitest";
import { assertTestDatabaseUrl } from "../helpers/testDatabase";

const testUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
process.env.DATABASE_URL = testUrl;
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.REQUIRE_EMAIL_VERIFICATION = "false";
process.env.EMAIL_PROVIDER = "console";
process.env.RATE_LIMIT_BACKEND = "memory";

const { resetEnvCache } = await import("@/lib/env");
const { settleBackgroundTasks } = await import("@/server/background");
const { MockEmailProvider, setEmailProviderForTesting } = await import("@/server/email");
const { MemoryRateLimiter, setRateLimiterForTesting } = await import("@/server/rateLimit");
const { InProcessEventBus, setEventBusForTesting } = await import("@/server/events");
const { prisma } = await import("@workmode/db");
const { setTestEmailProvider } = await import("../helpers/email");

resetEnvCache();

beforeEach(() => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
  resetEnvCache();
  const email = new MockEmailProvider();
  setEmailProviderForTesting(email);
  setTestEmailProvider(email);
  setRateLimiterForTesting(new MemoryRateLimiter());
  setEventBusForTesting(new InProcessEventBus());
});

afterEach(async () => {
  // Background work (emails) must not leak into the next test's mock provider.
  await settleBackgroundTasks();
});

afterAll(async () => {
  await prisma.$disconnect();
});
