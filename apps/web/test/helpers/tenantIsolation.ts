import { describe, expect, it } from "vitest";
import type { RouteHandler } from "@/server/http/apiHandler";
import { createTestOrg, createTestUser, loginAs, type TestOrg } from "./factories";
import { callRoute, type CallRouteOptions, type CookieJar, type ErrorBody } from "./http";

/**
 * Tenant-isolation matrix.
 *
 * Every endpoint that addresses a tenant-owned resource registers a case: "a manager of org A, using
 * A's session, targets org B's resource → must get 404 (or the given status) and B's data must be
 * unchanged". Cases live in `test/integration/tenantCases/*.ts` (one file per feature area) and are
 * all executed by `test/integration/tenant-isolation.test.ts`.
 *
 * ```ts
 * // test/integration/tenantCases/employees.ts
 * import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";
 * import { GET } from "@/app/api/employees/[employeeId]/route";
 *
 * registerTenantIsolationCase({
 *   name: "GET /api/employees/:id of another org",
 *   build: async (_a, b) => {
 *     const employee = await prisma.employee.create({ data: { organisationId: b.organisation.id, ... } });
 *     return { handler: GET, method: "GET", path: `/api/employees/${employee.id}`, params: { employeeId: employee.id } };
 *   },
 * });
 * ```
 */

export interface TenantFixture extends TestOrg {
  /** Signed-in OWNER of this organisation, organisation pre-selected. */
  jar: CookieJar;
}

export interface TenantRequest extends Omit<CallRouteOptions, "jar"> {
  handler: RouteHandler;
}

export interface TenantIsolationCase {
  name: string;
  /** Build a request against ORG B's resource; it is sent with ORG A's session. */
  build: (orgA: TenantFixture, orgB: TenantFixture) => Promise<TenantRequest> | TenantRequest;
  /** Expected status (default 404). */
  expectStatus?: number | readonly number[];
  /** Optional expected error code (e.g. `NOT_FOUND`). */
  expectCode?: string;
  /** Assert that org B's data is unchanged after the attempt. */
  verify?: (orgA: TenantFixture, orgB: TenantFixture) => Promise<void> | void;
}

const registry: TenantIsolationCase[] = [];

export function registerTenantIsolationCase(testCase: TenantIsolationCase): void {
  if (registry.some((c) => c.name === testCase.name)) {
    throw new Error(`Duplicate tenant isolation case: ${testCase.name}`);
  }
  registry.push(testCase);
}

export function registeredTenantIsolationCases(): readonly TenantIsolationCase[] {
  return registry;
}

export async function createTenantFixture(name: string): Promise<TenantFixture> {
  const owner = await createTestUser({ name: `${name} Owner` });
  const org = await createTestOrg({ owner, name });
  const jar = await loginAs(owner, { organisationId: org.organisation.id });
  return { ...org, jar };
}

/** Run one case: fresh orgs A and B, request built against B, sent as A. */
export async function runTenantIsolationCase(testCase: TenantIsolationCase): Promise<void> {
  const orgA = await createTenantFixture("Tenant A");
  const orgB = await createTenantFixture("Tenant B");
  const { handler, ...request } = await testCase.build(orgA, orgB);
  const result = await callRoute<ErrorBody>(handler, { ...request, jar: orgA.jar.clone() });
  const expected = testCase.expectStatus ?? 404;
  const allowed = Array.isArray(expected) ? expected : [expected];
  expect(
    allowed,
    `${testCase.name}: unexpected status ${result.status} ${JSON.stringify(result.body)}`,
  ).toContain(result.status);
  if (testCase.expectCode) expect(result.body.error?.code).toBe(testCase.expectCode);
  if (testCase.verify) await testCase.verify(orgA, orgB);
}

/** Define one Vitest test per registered case (call at module top level of the runner test file). */
export function defineTenantIsolationSuite(cases: readonly TenantIsolationCase[] = registry): void {
  describe("tenant isolation matrix", () => {
    it("has registered cases", () => {
      expect(cases.length).toBeGreaterThan(0);
    });
    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runTenantIsolationCase(testCase);
      });
    }
  });
}
