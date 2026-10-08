/**
 * Mock Planday cannot run in production (spec §0 rule 3, §11; plan §12.5). Every entry point that brings the
 * mock to life (`createMockPlanday`, `startMockPlandayHttpServer`, `apps/web/scripts/mock-planday.mts`) calls
 * `assertMockPlandayAllowed` first. Importing the module never throws, so a production bundle that merely
 * contains the mock (the web app's test transport) still starts; only using it is refused.
 *
 * The other lines of defence live in apps/web: `parseEnv` refuses `PLANDAY_MODE=mock` and `PLANDAY_MOCK_URL`
 * in production, the dev routes answer 404 there, and a connection made in mock mode (`isMock`) is refused in
 * live mode.
 */

/** Variables Railway injects into every deployment (same list as `isRailway` in apps/web/src/lib/env.ts). */
const RAILWAY_DEPLOYMENT_VARIABLES = [
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_ENVIRONMENT_NAME",
] as const;

export class MockPlandayForbiddenError extends Error {
  override readonly name = "MockPlandayForbiddenError";
}

/**
 * Why Mock Planday may not run in this environment, or `null` when it may: `NODE_ENV=production`, or any
 * Railway deployment (the mock is for local development, Vitest and Playwright only; no Railway service ever
 * needs it, whatever its NODE_ENV).
 */
export function mockPlandayRefusal(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production";
  const railway = RAILWAY_DEPLOYMENT_VARIABLES.find((key) => Boolean(env[key]?.trim()));
  if (railway) return `${railway} is set (a Railway deployment)`;
  return null;
}

/**
 * Throws `MockPlandayForbiddenError` when Mock Planday may not run here (see `mockPlandayRefusal`). The real
 * `process.env` is always checked; an injected `env` (tests) can only add a refusal, never lift one, so a caller
 * passing a partial or validated config object cannot bring the mock to life in a production process.
 */
export function assertMockPlandayAllowed(
  component: string,
  env?: Readonly<Record<string, string | undefined>>,
): void {
  const refusal =
    mockPlandayRefusal(process.env) ??
    (env !== undefined && env !== process.env ? mockPlandayRefusal(env) : null);
  if (refusal) {
    throw new MockPlandayForbiddenError(
      `${component} refused: Mock Planday never runs in production (${refusal}).`,
    );
  }
}
