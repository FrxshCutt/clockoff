import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
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
  if (route === ROUTES.home) return path.join(APP_DIR, "(marketing)", "page.tsx");
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
  // Every dashboard page now has a real body (data-driven empty states render only after a fetch), so the
  // bare-render contract is: exactly one <h1>, no "undefined" text. Set a key to an EmptyStateKey only for a
  // placeholder page.
  [ROUTES.overview]: null,
  [ROUTES.employees]: null,
  "/employees/[id]": null,
  [ROUTES.schedule]: null,
  [ROUTES.scheduleImport]: null,
  [ROUTES.policies]: null,
  [ROUTES.policyNew]: null,
  "/policies/[id]": null,
  [ROUTES.breakRules]: null,
  [ROUTES.breakRuleNew]: null,
  "/break-rules/[id]": null,
  [ROUTES.integrations]: null,
  [ROUTES.activity]: null,
  [ROUTES.locations]: null,
  [ROUTES.devices]: null,
  "/devices/[id]": null,
  [ROUTES.auditLogs]: null,
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

/** Pages call useRouter()/usePathname()/useSearchParams(); outside Next these need their contexts mounted. */
const stubRouter: AppRouterInstance = {
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
};

async function renderPage(route: string, id = SAMPLE_ID): Promise<string> {
  const { default: Page } = await loadPage(route);
  const element = await Page({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pathname = route.replace("[id]", id);
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={stubRouter}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <QueryClientProvider client={client}>
            <TooltipProvider>{element}</TooltipProvider>
          </QueryClientProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function digestOf(error: unknown): string {
  return typeof error === "object" && error !== null && "digest" in error
    ? String(error.digest)
    : "";
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
      ...Object.values(ROUTES).filter(
        (route) => route !== ROUTES.home && !AUTH_ROUTES.includes(route),
      ),
      ...DETAIL_ROUTES,
    ];
    expect(Object.keys(DASHBOARD_PAGES).sort()).toEqual([...dashboardRoutes].sort());
    for (const item of NAV_ITEMS) expect(DASHBOARD_PAGES, item.href).toHaveProperty([item.href]);
  });
});

describe("dashboard pages", () => {
  it.each(Object.entries(DASHBOARD_PAGES))(
    "%s renders one <h1> and its empty state",
    async (route, emptyState) => {
      const html = await renderPage(route);
      const headings = html.match(/<h1[\s>]/g)?.length ?? 0;
      // Detail pages title themselves after the record loads (a bare render shows their skeleton frame).
      if (DETAIL_ROUTES.includes(route)) expect(headings, route).toBeLessThanOrEqual(1);
      else expect(headings, route).toBe(1);
      expect(html).not.toMatch(/>undefined</);
      if (emptyState)
        expect(html).toContain(EMPTY_STATES[emptyState].title.replace(/'/g, "&#x27;"));
    },
  );

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
