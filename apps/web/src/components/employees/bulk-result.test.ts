import { describe, expect, it } from "vitest";
import { summariseBulkResult } from "./bulk-result";

const A = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const B = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";

describe("summariseBulkResult", () => {
  it("is a success when nothing failed", () => {
    expect(
      summariseBulkResult({ action: "ASSIGN_POLICY", processed: 3, succeeded: 3, failed: [] }),
    ).toEqual({
      tone: "success",
      title: "Policy assigned for 3 employees",
      description: null,
    });
  });

  it("warns with human copy per failure and names the employee when known", () => {
    const summary = summariseBulkResult(
      {
        action: "INVITE",
        processed: 2,
        succeeded: 1,
        failed: [{ employeeId: A, code: "EMPLOYEE_INACTIVE", message: "raw server text" }],
      },
      (id) => (id === A ? "Ada Lovelace" : null),
    );
    expect(summary.tone).toBe("warning");
    expect(summary.title).toBe("Invites sent for 1 of 2 employees");
    expect(summary.description).toContain("Ada Lovelace: This employee is deactivated");
    expect(summary.description).not.toContain("raw server text");
  });

  it("explains a REACTIVATE conflict as the plan limit", () => {
    const summary = summariseBulkResult({
      action: "REACTIVATE",
      processed: 1,
      succeeded: 0,
      failed: [{ employeeId: A, code: "CONFLICT", message: "raw" }],
    });
    expect(summary.tone).toBe("error");
    expect(summary.description).toContain("active-employee limit");
  });

  it("is an error when every item failed and truncates long failure lists", () => {
    const failed = [A, B, A, B, A].map((employeeId) => ({
      employeeId,
      code: "EMPLOYEE_NOT_FOUND" as const,
      message: "",
    }));
    const summary = summariseBulkResult({
      action: "DEACTIVATE",
      processed: 5,
      succeeded: 0,
      failed,
    });
    expect(summary.tone).toBe("error");
    expect(summary.title).toBe("Deactivate failed for 5 employees");
    expect(summary.description).toContain("…and 2 more.");
  });
});
