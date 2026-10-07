import { ROLES } from "@clockoff/shared/enums";
import { describe, expect, it } from "vitest";
import { assignableRoles, canInviteMembers, canManageMember, compareRoles } from "./member-rules";

describe("assignableRoles", () => {
  it("lets owners grant every role, admins grant admin/manager, managers nothing", () => {
    expect(assignableRoles("OWNER")).toEqual(["OWNER", "ADMIN", "MANAGER"]);
    expect(assignableRoles("ADMIN")).toEqual(["ADMIN", "MANAGER"]);
    expect(assignableRoles("MANAGER")).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });

  it("matches canInviteMembers", () => {
    for (const role of ROLES) {
      expect(canInviteMembers(role), role).toBe(assignableRoles(role).length > 0);
    }
    expect(canInviteMembers(null)).toBe(false);
  });
});

describe("canManageMember", () => {
  it("never offers actions on your own row", () => {
    for (const role of ROLES) {
      expect(canManageMember(role, { role, isCurrentUser: true }), role).toBe(false);
    }
  });

  it("only owners manage owners", () => {
    expect(canManageMember("OWNER", { role: "OWNER", isCurrentUser: false })).toBe(true);
    expect(canManageMember("ADMIN", { role: "OWNER", isCurrentUser: false })).toBe(false);
  });

  it("admins manage admins and managers; managers manage nobody", () => {
    expect(canManageMember("ADMIN", { role: "ADMIN", isCurrentUser: false })).toBe(true);
    expect(canManageMember("ADMIN", { role: "MANAGER", isCurrentUser: false })).toBe(true);
    expect(canManageMember("MANAGER", { role: "MANAGER", isCurrentUser: false })).toBe(false);
    expect(canManageMember(null, { role: "MANAGER", isCurrentUser: false })).toBe(false);
  });

  it("treats an unknown isCurrentUser (older API) as someone else", () => {
    expect(canManageMember("OWNER", { role: "MANAGER", isCurrentUser: null })).toBe(true);
  });
});

describe("compareRoles", () => {
  it("orders owners, then admins, then managers", () => {
    expect(
      ["MANAGER", "OWNER", "ADMIN"].sort((a, b) => compareRoles(a as never, b as never)),
    ).toEqual(["OWNER", "ADMIN", "MANAGER"]);
  });
});
