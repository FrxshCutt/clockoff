import { describe, expect, it } from "vitest";
import { ProviderError } from "@clockoff/shared/providers/workforceProvider";
import { z } from "zod";
import {
  isPlandayAuthError,
  isPlandayNotFound,
  PLANDAY_ERROR_CODES,
  PlandayError,
  PlandayRateLimitedError,
  toProviderError,
} from "./errors";
import { describeZodIssues, pathTemplate } from "./logging";

describe("PlandayError (§4.6)", () => {
  it("marks exactly the documented codes retryable", () => {
    const retryable = PLANDAY_ERROR_CODES.filter((code) => new PlandayError(code).retryable);
    expect(retryable).toEqual([
      "PLANDAY_RATE_LIMITED",
      "PLANDAY_UNAVAILABLE",
      "CREDENTIAL_PERSIST_FAILED",
    ]);
  });

  it("maps to the generic ProviderError codes", () => {
    const expected: Record<string, string> = {
      PLANDAY_AUTH_FAILED: "AUTH_EXPIRED",
      PLANDAY_SCOPE_MISSING: "AUTH_EXPIRED",
      PLANDAY_RATE_LIMITED: "RATE_LIMITED",
      PLANDAY_UNAVAILABLE: "PROVIDER_ERROR",
      PLANDAY_NOT_FOUND: "INVALID_RESPONSE",
      PLANDAY_INVALID_RESPONSE: "INVALID_RESPONSE",
      CREDENTIAL_PERSIST_FAILED: "PROVIDER_ERROR",
    };
    for (const code of PLANDAY_ERROR_CODES) {
      const mapped = toProviderError(new PlandayError(code));
      expect(mapped, code).toBeInstanceOf(ProviderError);
      expect(mapped.provider).toBe("PLANDAY");
      expect(mapped.code, code).toBe(expected[code]);
      expect(mapped.retryable, code).toBe(new PlandayError(code).retryable);
    }
  });

  it("builds messages from the code, scopes, reason, path template and status only", () => {
    const err = new PlandayError("PLANDAY_SCOPE_MISSING", {
      missingScopes: ["employee:read"],
      pathTemplate: "/hr/v1.0/employees",
      status: 403,
    });
    expect(err.message).toBe(
      "The Planday app is missing a required scope (missing: employee:read) on /hr/v1.0/employees (HTTP 403)",
    );
    const parked = new PlandayRateLimitedError(new Date("2026-10-21T10:31:00Z"), { status: 429 });
    expect(parked).toBeInstanceOf(PlandayError);
    expect(parked).toMatchObject({ code: "PLANDAY_RATE_LIMITED", retryable: true, status: 429 });
    expect(parked.retryAt.toISOString()).toBe("2026-10-21T10:31:00.000Z");
  });

  it("classifies auth and not-found errors", () => {
    expect(isPlandayAuthError(new PlandayError("PLANDAY_AUTH_FAILED"))).toBe(true);
    expect(isPlandayAuthError(new PlandayError("PLANDAY_SCOPE_MISSING"))).toBe(true);
    expect(isPlandayAuthError(new PlandayError("PLANDAY_UNAVAILABLE"))).toBe(false);
    expect(isPlandayNotFound(new PlandayError("PLANDAY_NOT_FOUND"))).toBe(true);
    expect(isPlandayNotFound(new Error("x"))).toBe(false);
  });
});

describe("logging helpers (§4.9)", () => {
  it("replaces id segments and drops hosts and query strings", () => {
    expect(pathTemplate("/hr/v1.0/employees/1001")).toBe("/hr/v1.0/employees/{id}");
    expect(pathTemplate("/punchclock/v1.0/punchclockshifts/7/breaks")).toBe(
      "/punchclock/v1.0/punchclockshifts/{id}/breaks",
    );
    expect(
      pathTemplate(
        "https://openapi.planday.com/scheduling/v1.0/shifts?from=2026-10-19&employeeId=1001",
      ),
    ).toBe("/scheduling/v1.0/shifts");
    expect(pathTemplate("/portal/v1.0/info")).toBe("/portal/v1.0/info");
  });

  it("reduces Zod issues to paths and codes, never values", () => {
    const schema = z.object({ data: z.array(z.object({ id: z.number(), name: z.string() })) });
    const result = schema.safeParse({ data: [{ id: "SENTINEL-1001", name: "Aisha" }, { id: 2 }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeZodIssues(result.error)).toEqual([
      { path: "data.0.id", code: "invalid_type" },
      { path: "data.1.name", code: "invalid_type" },
    ]);
    expect(JSON.stringify(describeZodIssues(result.error))).not.toMatch(/SENTINEL|Aisha/);
  });
});
