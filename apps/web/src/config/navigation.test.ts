import { describe, expect, it } from "vitest";
import {
  AUTH_ROUTES,
  NAV_ITEMS,
  NAV_SECTIONS,
  ROUTES,
  SEGMENT_LABELS,
  getActiveNavItem,
  getBreadcrumbs,
  getPostAuthRedirect,
  isNavItemActive,
  isResourceId,
  loginRedirectUrl,
  routeFor,
  isInternalPath,
  safeRedirectPath,
} from "./navigation";

describe("navigation config", () => {
  it("lists every sidebar destination from the spec, in order", () => {
    expect(NAV_ITEMS.map((item) => [item.title, item.href])).toEqual([
      ["Overview", "/overview"],
      ["Employees", "/employees"],
      ["Schedule", "/schedule"],
      ["Policies", "/policies"],
      ["Break Rules", "/break-rules"],
      ["Integrations", "/integrations"],
      ["Activity", "/activity"],
      ["Locations & Teams", "/locations"],
      ["Settings", "/settings"],
      ["Billing", "/billing"],
      ["Help", "/help"],
    ]);
  });

  it("has unique hrefs, an icon and a description for every item, and non-empty sections", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of NAV_ITEMS) {
      expect(item.icon, item.title).toBeTruthy();
      expect(item.description.length, item.title).toBeGreaterThan(0);
    }
    for (const section of NAV_SECTIONS) expect(section.items.length, section.id).toBeGreaterThan(0);
  });

  it("has a breadcrumb label for every static dashboard segment", () => {
    const dashboardRoutes = Object.values(ROUTES).filter(
      (route) => route !== ROUTES.home && !AUTH_ROUTES.includes(route),
    );
    for (const route of dashboardRoutes) {
      for (const segment of route.split("/").filter(Boolean)) {
        expect(SEGMENT_LABELS[segment], `${route} → ${segment}`).toBeTruthy();
      }
    }
  });

  it("builds encoded detail routes", () => {
    expect(routeFor.employee("abc")).toBe("/employees/abc");
    expect(routeFor.policy("a/b")).toBe("/policies/a%2Fb");
    expect(routeFor.settingsTab("join-code")).toBe("/settings?tab=join-code");
  });
});

describe("active nav item", () => {
  it("matches exact paths and descendants, not prefixes of other words", () => {
    expect(isNavItemActive("/employees", "/employees")).toBe(true);
    expect(isNavItemActive("/employees/123", "/employees")).toBe(true);
    expect(isNavItemActive("/employees/", "/employees")).toBe(true);
    expect(isNavItemActive("/employees?status=x", "/employees")).toBe(true);
    expect(isNavItemActive("/employeesx", "/employees")).toBe(false);
    expect(isNavItemActive(null, "/employees")).toBe(false);
  });

  it("picks the nav item for nested routes", () => {
    expect(getActiveNavItem("/schedule/import")?.href).toBe("/schedule");
    expect(getActiveNavItem("/break-rules/abc")?.href).toBe("/break-rules");
    expect(getActiveNavItem("/devices")).toBeUndefined();
  });
});

describe("getBreadcrumbs", () => {
  it("labels static and dynamic segments", () => {
    expect(getBreadcrumbs("/employees/0b7c2d1e-0000-4000-8000-000000000000")).toEqual([
      { label: "Employees", href: "/employees", segment: "employees", isDynamic: false },
      {
        label: "Details",
        href: "/employees/0b7c2d1e-0000-4000-8000-000000000000",
        segment: "0b7c2d1e-0000-4000-8000-000000000000",
        isDynamic: true,
      },
    ]);
  });

  it("uses registered labels for dynamic segments and ignores the query string", () => {
    const crumbs = getBreadcrumbs("/policies/p1?tab=history", { p1: "Front of house" });
    expect(crumbs.map((c) => c.label)).toEqual(["Policies", "Front of house"]);
    expect(getBreadcrumbs("/schedule/import").map((c) => c.label)).toEqual(["Schedule", "Import"]);
    expect(getBreadcrumbs("/")).toEqual([]);
  });

  it("survives malformed percent-encoding", () => {
    expect(getBreadcrumbs("/employees/%E0%A4%A").at(-1)?.segment).toBe("%E0%A4%A");
  });
});

describe("safeRedirectPath", () => {
  it("allows same-origin paths", () => {
    expect(safeRedirectPath("/employees?status=INVITED")).toBe("/employees?status=INVITED");
    expect(safeRedirectPath("/accept-invite?token=abc")).toBe("/accept-invite?token=abc");
  });

  it.each([
    ["absolute URL", "https://evil.example/"],
    ["protocol-relative", "//evil.example"],
    ["backslash trick", "/\\evil.example"],
    ["embedded backslash", "/foo\\bar"],
    ["control characters", "/foo\nbar"],
    ["javascript scheme", "javascript:alert(1)"],
    ["relative path", "employees"],
    ["login loop", "/login?next=/x"],
    ["register", "/register"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(safeRedirectPath(value)).toBeNull();
  });

  it("rejects nullish input", () => {
    expect(safeRedirectPath(null)).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
  });
});

describe("post-auth redirects", () => {
  it("sends managers without an organisation to create one", () => {
    expect(getPostAuthRedirect({ organisationCount: 0 })).toBe("/create-organisation");
    expect(getPostAuthRedirect({ organisationCount: 0, next: "/employees" })).toBe("/create-organisation");
  });

  it("lets an invite acceptance continue even without an organisation", () => {
    expect(getPostAuthRedirect({ organisationCount: 0, next: "/accept-invite?token=t" })).toBe("/accept-invite?token=t");
  });

  it("sends members to `next` or the overview", () => {
    expect(getPostAuthRedirect({ organisationCount: 2 })).toBe("/overview");
    expect(getPostAuthRedirect({ organisationCount: 1, next: "/policies" })).toBe("/policies");
    expect(getPostAuthRedirect({ organisationCount: 1, next: "//evil.example" })).toBe("/overview");
  });

  it("builds the login URL with an encoded next parameter", () => {
    expect(loginRedirectUrl("/employees?q=a b")).toBe("/login?next=%2Femployees%3Fq%3Da%20b");
    expect(loginRedirectUrl("/overview")).toBe("/login");
    expect(loginRedirectUrl("https://evil.example")).toBe("/login");
    expect(loginRedirectUrl(null)).toBe("/login");
  });
});

describe("isResourceId", () => {
  it("accepts UUIDs only", () => {
    expect(isResourceId("0b7c2d1e-1a2b-4c3d-8e9f-0123456789ab")).toBe(true);
    expect(isResourceId("0B7C2D1E-1A2B-4C3D-8E9F-0123456789AB")).toBe(true);
    expect(isResourceId("new")).toBe(false);
    expect(isResourceId("0b7c2d1e-1a2b-4c3d-8e9f-0123456789ab/x")).toBe(false);
    expect(isResourceId(undefined)).toBe(false);
  });
});

describe("isInternalPath", () => {
  it("accepts same-origin paths, including auth pages", () => {
    expect(isInternalPath("/policies/new")).toBe(true);
    expect(isInternalPath("/settings?tab=members#invites")).toBe(true);
    expect(isInternalPath("/login")).toBe(true);
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/a\tb", "javascript:alert(1)", "policies", "", null, undefined])(
    "rejects %j",
    (value) => {
      expect(isInternalPath(value)).toBe(false);
    },
  );
});
