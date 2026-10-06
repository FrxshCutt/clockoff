import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EMPTY_STATES, type EmptyStateKey } from "./emptyStates";
import { AUTH_ROUTES, NAV_ITEMS, ROUTES, routeFor } from "./navigation";

/**
 * Every route in the navigation config has a page, and every dashboard page renders its frame (one `<h1>`,
 * plus the configured empty state for placeholder pages) so feature work replaces bodies, not routes.
 */

const APP_DIR = path.resolve(import.meta.dirname, "../app");
const SAMPLE_ID = "0b7c2d1e-5a4f-4c3b-9d2e-1f0a9b8c7d6e";

/** Route pattern → the route group that owns it. Detail routes use Next's `[id]` segment. */
function pageFileFor(route: string): string {
  if (route === ROUTES.home) return path.join(APP_DIR, "page.tsx");
  const group = AUTH_ROUTES.includes(route) ? "(auth)" : "(dashboard)";
  return path.join(APP_DIR, group, ...route.split("/").filter(Boolean), "page.tsx");
}

const DETAIL_ROUTES = [
  routeFor.employee("[id]"),
  routeFor.policy("[id]"),
  routeFor.breakRule("[id]"),
  routeFor.device("[id]"),
].map((route) => decodeURIComponent(route));

/** Dashboard routes → the empty state their placeholder shows (null: the page has a real body already). */
const DASHBOARD_PAGES: Record<string, EmptyStateKey | null> = {
  [ROUTES.overview]: "overview",
  [ROUTES.employees]: "employees",
  "/employees/[id]": "employeeDetail",
  [ROUTES.schedule]: "schedule",
  [ROUTES.scheduleImport]: "scheduleImport",
  [ROUTES.policies]: "policies",
  [ROUTES.policyNew]: "policyNew",
  "/policies/[id]": "policyDetail",
  [ROUTES.breakRules]: "breakRules",
  [ROUTES.breakRuleNew]: "breakRuleNew",
  "/break-rules/[id]": "breakRuleDetail",
  [ROUTES.integrations]: "integrations",
  [ROUTES.activity]: "activity",
  [ROUTES.locations]: "locations",
  [ROUTES.devices]: "devices",
  "/devices/[id]": "deviceDetail",
  [ROUTES.auditLogs]: "auditLogs",
  [ROUTES.settings]: null,
  [ROUTES.billing]: null,
  [ROUTES.help]: null,
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}
type PageModule = { default: (props: PageProps) => ReactNode | Promise<ReactNode> };

async function loadPage(route: string): Promise<PageModule> {
  return (await import(/* @vite-ignore */ pageFileFor(route))) as PageModule;
}

async function renderPage(route: string, id = SAMPLE_ID): Promise<string> {
  const { default: Page } = await loadPage(route);
  const element = await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{element}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function digestOf(error: unknown): string {
  return typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : "";
}

describe("route coverage", () => {
  it.each(Object.values(ROUTES))("%s has a page", (route) => {
    expect(existsSync(pageFileFor(route)), pageFileFor(route)).toBe(true);
  });

  it.each(DETAIL_ROUTES)("%s has a page", (route) => {
    expect(existsSync(pageFileFor(route)), pageFileFor(route)).toBe(true);
  });

  it("covers every dashboard route in this table", () => {
    const dashboardRoutes = [
      ...Object.values(ROUTES).filter((route) => route !== ROUTES.home && !AUTH_ROUTES.includes(route)),
      ...DETAIL_ROUTES,
    ];
    expect(Object.keys(DASHBOARD_PAGES).sort()).toEqual([...dashboardRoutes].sort());
    for (const item of NAV_ITEMS) expect(DASHBOARD_PAGES, item.href).toHaveProperty([item.href]);
  });
});

describe("dashboard pages", () => {
  it.each(Object.entries(DASHBOARD_PAGES))("%s renders one <h1> and its empty state", async (route, emptyState) => {
    const html = await renderPage(route);
    expect(html.match(/<h1[\s>]/g)?.length, route).toBe(1);
    expect(html).not.toMatch(/>undefined</);
    if (emptyState) expect(html).toContain(EMPTY_STATES[emptyState].title.replace(/'/g, "&#x27;"));
  });

  it.each(DETAIL_ROUTES)("%s returns 404 for an id that isn't a UUID", async (route) => {
    const error: unknown = await renderPage(route, "not-a-uuid").then(
      () => null,
      (err: unknown) => err,
    );
    expect(digestOf(error)).toContain("404");
  });

  it("/dashboard redirects to the overview", async () => {
    const error: unknown = await renderPage("/dashboard").then(
      () => null,
      (err: unknown) => err,
    );
    expect(digestOf(error)).toContain("NEXT_REDIRECT");
    expect(digestOf(error)).toContain(ROUTES.overview);
  });
});
