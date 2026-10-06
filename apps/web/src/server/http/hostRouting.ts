/**
 * Hostname-based routing (docs/DEPLOYMENT.md). One deployment serves two sites:
 *
 *   DOMAIN, www.DOMAIN  → the marketing site (`app/(marketing)`) + the public demo-request API
 *   app.DOMAIN          → the manager dashboard, auth pages and every other `/api/*` route
 *
 * Paths that belong to the other site are redirected there, so each page has one canonical URL and the
 * dashboard's cookies are only ever set on `app.DOMAIN`. Edge-safe (no Node APIs): the middleware runs it.
 *
 * Off unless `HOST_ROUTING=on` and both `APP_URL` and `MARKETING_URL` are valid URLs on different hosts.
 * Requests to any other host (localhost, `*.netlify.app` and deploy-preview URLs) are never touched, so local
 * development and preview deployments keep serving everything from one origin.
 */

/** Top-level marketing pages (`src/app/(marketing)/**`). A test keeps this list in sync with the folder. */
export const MARKETING_PATHS = [
  "/",
  "/product",
  "/how-it-works",
  "/for-businesses",
  "/pricing",
  "/privacy",
  "/request-demo",
] as const;

/** API routes the marketing site itself calls (same-origin on the marketing host). */
export const MARKETING_API_PATHS = ["/api/request-demo", "/api/health"] as const;

export interface HostRoutingConfig {
  /** `app.DOMAIN` */
  appHost: string;
  /** `https://app.DOMAIN` */
  appOrigin: string;
  /** Canonical marketing host, e.g. `DOMAIN`. */
  marketingHost: string;
  /** `https://DOMAIN` */
  marketingOrigin: string;
  /** Extra hosts that redirect to the canonical marketing host (e.g. `www.DOMAIN`). */
  marketingAliasHosts: readonly string[];
}

type EnvLike = Record<string, string | undefined>;

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Reads the routing config from the environment; `null` when routing is off or misconfigured. */
export function readHostRoutingConfig(env: EnvLike): HostRoutingConfig | null {
  const flag = (env.HOST_ROUTING ?? "").trim().toLowerCase();
  if (flag !== "on" && flag !== "true" && flag !== "1") return null;

  const app = parseUrl(env.APP_URL ?? env.NEXT_PUBLIC_APP_URL);
  const marketing = parseUrl(env.MARKETING_URL);
  if (!app || !marketing) return null;
  const appHost = app.host.toLowerCase();
  const marketingHost = marketing.host.toLowerCase();
  if (appHost === marketingHost) return null;

  const aliases = new Set<string>();
  if (!marketingHost.startsWith("www.")) aliases.add(`www.${marketingHost}`);
  for (const extra of (env.MARKETING_ALIAS_HOSTS ?? "").split(",")) {
    const host = extra.trim().toLowerCase();
    if (host && host !== marketingHost && host !== appHost) aliases.add(host);
  }

  return {
    appHost,
    appOrigin: app.origin,
    marketingHost,
    marketingOrigin: marketing.origin,
    marketingAliasHosts: [...aliases],
  };
}

export type HostRoutingDecision =
  | { action: "next" }
  | { action: "redirect"; location: string; status: 307 | 308 }
  | { action: "not_found" };

export interface HostRoutingRequest {
  /** `Host` header (may include a port). */
  host: string | null;
  pathname: string;
  /** Query string including the leading `?`, or "". */
  search: string;
}

function isMarketingPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (MARKETING_PATHS as readonly string[]).includes(path);
}

function isMarketingApiPath(pathname: string): boolean {
  return (MARKETING_API_PATHS as readonly string[]).includes(pathname.replace(/\/+$/, ""));
}

/** Decides what the middleware does with a request, given the routing config. Pure. */
export function routeByHost(
  config: HostRoutingConfig | null,
  req: HostRoutingRequest,
): HostRoutingDecision {
  if (!config || !req.host) return { action: "next" };
  const host = req.host.toLowerCase();
  const { pathname, search } = req;

  // www (and any other alias) → canonical marketing host, same path. Permanent.
  if (config.marketingAliasHosts.includes(host)) {
    return {
      action: "redirect",
      location: `${config.marketingOrigin}${pathname}${search}`,
      status: 308,
    };
  }

  if (host === config.marketingHost) {
    if (isMarketingPath(pathname)) return { action: "next" };
    if (pathname.startsWith("/api/")) {
      // Auth, dashboard and mobile APIs live on the app host only; never redirect API calls.
      return isMarketingApiPath(pathname) ? { action: "next" } : { action: "not_found" };
    }
    // Dashboard and auth pages (/login, /overview, …) → the app host.
    return { action: "redirect", location: `${config.appOrigin}${pathname}${search}`, status: 308 };
  }

  if (host === config.appHost) {
    if (pathname === "/") {
      // Not permanent: the dashboard gate decides between /overview and /login.
      return { action: "redirect", location: `${config.appOrigin}/overview${search}`, status: 307 };
    }
    if (isMarketingPath(pathname)) {
      return {
        action: "redirect",
        location: `${config.marketingOrigin}${pathname}${search}`,
        status: 308,
      };
    }
    return { action: "next" };
  }

  // Unknown host (localhost, *.netlify.app, deploy previews): serve everything as-is.
  return { action: "next" };
}

/**
 * The browser Origin a mutating request to this host is allowed to carry. The app host (and any host
 * when routing is off) accepts only the `APP_URL` origin; the marketing host accepts its own origin, and
 * only for the marketing APIs (everything else is 404'd there by `routeByHost`).
 */
export function allowedOriginForRequest(
  config: HostRoutingConfig | null,
  appOrigin: string | null,
  req: { host: string | null; pathname: string },
): string | null {
  if (
    config &&
    req.host &&
    req.host.toLowerCase() === config.marketingHost &&
    isMarketingApiPath(req.pathname)
  ) {
    return config.marketingOrigin;
  }
  return appOrigin;
}
