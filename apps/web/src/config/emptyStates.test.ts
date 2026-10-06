import { describe, expect, it } from "vitest";
import { EMPTY_STATES, type EmptyStateCopy } from "./emptyStates";
import { ROUTES } from "./navigation";

const ALL_ROUTES = new Set<string>(Object.values(ROUTES));

describe("empty-state copy", () => {
  it("quotes the spec verbatim for NO EMPLOYEES and NO POLICY", () => {
    expect(EMPTY_STATES.employees.description).toBe("Add your first employee to begin setting up distraction-free shifts.");
    expect(EMPTY_STATES.employees.action.label).toBe("Add Employee");
    expect(EMPTY_STATES.policies.description).toBe(
      "Create a Work Policy to decide which distractions are restricted during shifts.",
    );
    expect(EMPTY_STATES.policies.action.label).toBe("Create Policy");
  });

  it("has an icon, title and description for every entry, and only links to known routes", () => {
    for (const [key, copy] of Object.entries(EMPTY_STATES) as [string, EmptyStateCopy][]) {
      expect(copy.icon, key).toBeTruthy();
      expect(copy.title.trim(), key).not.toBe("");
      expect(copy.description, key).toMatch(/[.!?]$/);
      for (const action of [copy.action, copy.secondaryAction]) {
        if (action?.href) expect(ALL_ROUTES.has(action.href), `${key} → ${action.href}`).toBe(true);
        if (action) expect(action.label.trim(), key).not.toBe("");
      }
    }
  });
});
