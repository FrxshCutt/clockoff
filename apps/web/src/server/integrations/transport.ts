import {
  PLANDAY_API_BASE_URL,
  PLANDAY_AUTHORIZE_URL,
  PLANDAY_ID_BASE_URL,
  type PlandayFetch,
  type PlandayTransport,
} from "@clockoff/integrations";
import { env } from "@/lib/env";

/**
 * How Planday requests leave the process (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.1, §12.1):
 *
 * - live (`PLANDAY_MODE=live`, always in production): `globalThis.fetch`, Planday's own authorize endpoint;
 * - mock (development, Playwright): a fetch that rewrites `https://openapi.planday.com/…` to
 *   `${PLANDAY_MOCK_URL}/openapi/…` and `https://id.planday.com/…` to `${PLANDAY_MOCK_URL}/id/…` (the shared mock
 *   server, so web and the worker see one portal) and refuses every other host; method A's browser goes to the
 *   dev authorize route;
 * - tests: the in-process mock injected with {@link setPlandayTransportForTesting}.
 *
 * The client's base URLs never change. The transport is resolved on every request, so a test that swaps the mock
 * needs no re-registration of the provider.
 */

/** A transport plus the clock its tokens are dated with (the in-process mock's clock in tests). */
export interface TestPlandayTransport extends PlandayTransport {
  /** The mock's clock; the provider and the credential store use it instead of the real one. */
  readonly clock?: () => Date;
}

let testTransport: TestPlandayTransport | null = null;

/**
 * Tests only: route every Planday request through `transport` (normally `createMockPlanday(...)`, whose `fetch`
 * answers both Planday hosts in process). `null` restores the environment's transport.
 */
export function setPlandayTransportForTesting(transport: TestPlandayTransport | null): void {
  testTransport = transport;
}

/** The clock of the injected test transport, if any (the provider's HTTP clock follows it). */
export function plandayTransportClock(): (() => Date) | undefined {
  return testTransport?.clock;
}

function bindGlobalFetch(): PlandayFetch {
  return (url, init) => globalThis.fetch(url, init);
}

/** The mock-mode fetch: only the two Planday hosts, rewritten onto the mock server; anything else throws. */
export function mockServerFetch(mockUrl: string, fetchImpl: PlandayFetch = bindGlobalFetch()) {
  const base = mockUrl.replace(/\/+$/, "");
  const fetch: PlandayFetch = (url, init) => {
    let target: string;
    if (url.startsWith(`${PLANDAY_API_BASE_URL}/`)) {
      target = `${base}/openapi/${url.slice(PLANDAY_API_BASE_URL.length + 1)}`;
    } else if (url.startsWith(`${PLANDAY_ID_BASE_URL}/`)) {
      target = `${base}/id/${url.slice(PLANDAY_ID_BASE_URL.length + 1)}`;
    } else {
      // Never a path or query: they may carry ids.
      return Promise.reject(
        new Error(`Mock Planday transport refused a request to ${new URL(url).host}`),
      );
    }
    return fetchImpl(target, init);
  };
  return fetch;
}

export function getPlandayTransport(): PlandayTransport {
  if (testTransport) return testTransport;
  const e = env();
  if (e.PLANDAY_MODE === "live") {
    return { fetch: bindGlobalFetch(), authorizeBaseUrl: PLANDAY_AUTHORIZE_URL };
  }
  const mockUrl = e.PLANDAY_MOCK_URL;
  if (!mockUrl) {
    throw new Error(
      "PLANDAY_MODE=mock needs PLANDAY_MOCK_URL (start `pnpm --filter @clockoff/web mock:planday`), or a test transport",
    );
  }
  return {
    fetch: mockServerFetch(mockUrl),
    authorizeBaseUrl: `${e.APP_ORIGIN}/api/dev/mock-planday/authorize`,
  };
}

/**
 * A transport that resolves {@link getPlandayTransport} per request: what the registered provider holds, so the
 * mode, the mock URL and an injected test transport are read when a request is made, not when the provider was
 * registered.
 */
export const resolvingPlandayTransport: PlandayTransport = {
  fetch: (url, init) => getPlandayTransport().fetch(url, init),
  get authorizeBaseUrl() {
    return getPlandayTransport().authorizeBaseUrl;
  },
};
