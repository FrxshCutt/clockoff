import type { Policy } from "@workmode/validation/policies";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PolicyCard } from "./policy-card";
import { PrecedenceExplainer } from "./precedence-explainer";
import { DEFAULT_SHIELD_PREVIEW_MESSAGE, ShieldPreview } from "./shield-preview";

/**
 * Server-render smoke tests (node, no DOM) for the presentational pieces of the Policies pages. Interactive
 * behaviour (menus, dialogs, forms) is exercised in the browser, not here.
 */

const NOW = new Date("2026-10-06T12:00:00Z");

const POLICY: Policy = {
  id: "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10",
  name: "Front of house",
  description: "Bar and floor staff",
  status: "ACTIVE",
  currentVersion: {
    id: "8d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    policyId: "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10",
    versionNumber: 3,
    restrictionConfig: {
      categories: ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT", "STREAMING", "VIDEO", "SHOPPING"],
      requireEmployeeAppSelection: true,
      alwaysAllowedNote: [],
      activationMode: "SCHEDULED",
      preShiftWarningMinutes: 10,
    },
    breakBehaviourDefault: { restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] },
    changeNote: null,
    publishedAt: "2026-10-04T12:00:00Z",
    createdBy: null,
    createdAt: "2026-10-04T11:00:00Z",
  },
  draftVersion: null,
  isDefault: true,
  assignmentCount: 2,
  assignedEmployeeCount: 12,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-04T12:00:00Z",
};

describe("PolicyCard", () => {
  it("shows name, status, default marker, category chips (capped) and the version line", () => {
    const html = renderToStaticMarkup(<PolicyCard policy={POLICY} now={NOW} />);
    expect(html).toContain("Front of house");
    expect(html).toContain('href="/policies/6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10"');
    expect(html).toContain('data-kind="policyStatus"');
    expect(html).toContain('data-value="ACTIVE"');
    expect(html).toContain("Default");
    expect(html).toContain("Social Media");
    expect(html).toContain("+2 more");
    expect(html).toContain("12 employees · 2 assignments");
    expect(html).toContain("v3 · published 2d ago");
  });
});

describe("ShieldPreview", () => {
  it("falls back to the iOS app's own default copy and otherwise shows the manager's message", () => {
    const empty = renderToStaticMarkup(<ShieldPreview message="   " organisationName="Acme" />);
    expect(empty).toContain("Acme");
    expect(empty).toContain(DEFAULT_SHIELD_PREVIEW_MESSAGE.replace(/'/g, "&#x27;"));
    expect(empty).toContain("default message");
    const custom = renderToStaticMarkup(<ShieldPreview message="Heads down until 5pm" />);
    expect(custom).toContain("Heads down until 5pm");
    expect(custom).toContain("Your organisation");
  });
});

describe("PrecedenceExplainer", () => {
  it("renders the hierarchy summary and every level when open", () => {
    const html = renderToStaticMarkup(<PrecedenceExplainer noun="policy" defaultOpen />);
    expect(html).toContain("Which policy applies?");
    expect(html).toContain("Employee &gt; Team &gt; Location &gt; Organisation");
    for (const label of ["Employee", "Team", "Location", "Organisation"]) expect(html).toContain(label);
  });
});
