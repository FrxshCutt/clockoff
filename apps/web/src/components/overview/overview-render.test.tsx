import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingOverview } from "@/components/billing/billing-overview";
import { JoinCodeQuickCopy } from "@/components/shell/join-code-quick-copy";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CurrentOrganisation, OnboardingChecklist as Checklist } from "@/hooks/api-shapes";
import type { NotificationsState } from "@/hooks/use-notifications";
import type { Availability } from "@/hooks/use-settings";
import { ApiClientError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { JoinCodeCard } from "./join-code-card";
import { OnboardingChecklist } from "./onboarding-checklist";

/** Server-render the overview widgets, billing and top-bar widgets against a seeded cache. */
const ORGANISATION: CurrentOrganisation = {
  organisation: {
    id: "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10",
    name: "Harbour Café",
    slug: "harbour-cafe",
    timezone: "Europe/London",
    dateFormat: "DMY",
    plan: "BUSINESS",
    billingStatus: "PAST_DUE",
    settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
  },
  role: "OWNER",
  membershipId: null,
  joinCode: "HARB42",
};

function render(node: ReactNode, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const checklist = (overrides: Partial<Checklist> = {}): Checklist => ({
  items: [
    { key: "createCompany", label: "Create your company", done: true, href: "/settings" },
    { key: "createPolicy", label: "Create a Work Policy", done: false, href: "/policies/new" },
  ],
  completedCount: 1,
  totalCount: 2,
  complete: false,
  dismissedAt: null,
  ...overrides,
});

describe("OnboardingChecklist", () => {
  it("shows progress, the next step and links for each step", () => {
    const html = render(<OnboardingChecklist />, (c) => c.setQueryData(queryKeys.onboarding, checklist()));
    expect(html).toContain("1 of 2 steps complete");
    expect(html).toContain("Next: Create a Work Policy");
    expect(html).toContain('href="/policies/new"');
    expect(html).toContain('aria-label="Setup 50% complete"');
    expect(html).toContain('aria-label="Dismiss setup checklist"');
  });

  it("stays out of the way when the endpoint is missing, but reports other failures with a retry", () => {
    const failWith = (error: ApiClientError) => (c: QueryClient) => {
      // Keep the seeded error on mount (otherwise the observer optimistically re-fetches and shows loading).
      c.setQueryDefaults(queryKeys.onboarding, { retryOnMount: false });
      c.getQueryCache()
        .build(c, { queryKey: queryKeys.onboarding })
        .setState({ status: "error", error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
    };
    expect(render(<OnboardingChecklist />, failWith(new ApiClientError({ code: "NOT_FOUND", status: 404, message: "x" })))).toBe("");
    const html = render(<OnboardingChecklist />, failWith(new ApiClientError({ code: "INTERNAL_ERROR", status: 500, message: "x" })));
    expect(html).toContain("Couldn&#x27;t load your setup checklist");
    expect(html).toContain("Try again");
    expect(html).not.toContain("x</p>");
  });

  it("disappears once complete or dismissed", () => {
    expect(render(<OnboardingChecklist />, (c) => c.setQueryData(queryKeys.onboarding, checklist({ complete: true })))).toBe("");
    expect(
      render(<OnboardingChecklist />, (c) => c.setQueryData(queryKeys.onboarding, checklist({ dismissedAt: "2026-10-02T00:00:00Z" }))),
    ).toBe("");
  });
});

describe("join code widgets", () => {
  it("shows the code with a copy button on the overview and in the top bar", () => {
    const seed = (c: QueryClient) => c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
    expect(render(<JoinCodeCard />, seed)).toContain("HARB42");
    const chip = render(<JoinCodeQuickCopy />, seed);
    expect(chip).toContain("HARB42");
    expect(chip).toContain('aria-label="Copy company join code"');
  });

  it("hides the top-bar chip when there is no active code", () => {
    expect(render(<JoinCodeQuickCopy />, (c) => c.setQueryData(queryKeys.currentOrganisation, { ...ORGANISATION, joinCode: null }))).toBe("");
  });
});

describe("NotificationsBell", () => {
  it("announces the unread count and caps the badge at 9+", () => {
    const feed: NotificationsState = {
      available: true,
      unreadCount: 12,
      items: [],
    };
    const html = render(<NotificationsBell />, (c) => c.setQueryData(queryKeys.notifications, feed));
    expect(html).toContain('aria-label="Notifications, 12 unread"');
    expect(html).toContain(">9+<");
  });

  it("has a plain label with nothing unread", () => {
    const feed: NotificationsState = { available: false, unreadCount: 0, items: [] };
    const html = render(<NotificationsBell />, (c) => c.setQueryData(queryKeys.notifications, feed));
    expect(html).toContain('aria-label="Notifications"');
  });
});

describe("BillingOverview", () => {
  it("shows the plan, a past-due warning and the plan catalogue", () => {
    const html = render(<BillingOverview />, (c) => {
      c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
      c.setQueryData(queryKeys.currentUser, {
        user: { id: "u", email: "a@example.com", name: "Ada", emailVerified: true, createdAt: "2026-10-01T00:00:00Z" },
        organisations: [{ id: ORGANISATION.organisation.id, name: "Harbour Café", slug: "harbour-cafe", role: "OWNER", timezone: "Europe/London" }],
        currentOrganisationId: ORGANISATION.organisation.id,
        csrfToken: "x",
      });
      c.setQueryData<Availability<never>>(queryKeys.billing, { available: false, data: null });
    });
    expect(html).toContain("Payment overdue");
    expect(html).toContain('data-value="PAST_DUE"');
    expect(html).toContain("Current plan");
    expect(html).toContain("Contact us to change plan");
    expect((html.match(/<h3/g) ?? []).length).toBe(4);
  });

  it("says when usage couldn't be loaded instead of silently leaving it out", () => {
    const html = render(<BillingOverview />, (c) => {
      c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
      c.setQueryDefaults(queryKeys.billing, { retryOnMount: false });
      c.getQueryCache()
        .build(c, { queryKey: queryKeys.billing })
        .setState({
          status: "error",
          error: new ApiClientError({ code: "INTERNAL_ERROR", status: 500, message: "stack trace here" }),
          fetchStatus: "idle",
          errorUpdatedAt: 1,
          errorUpdateCount: 1,
        });
    });
    expect(html).toContain("Usage couldn&#x27;t be loaded");
    expect(html).toContain("Try again");
    expect(html).not.toContain("stack trace here");
  });
});
