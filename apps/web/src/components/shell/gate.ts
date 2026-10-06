import { isUnauthenticatedError } from "@/lib/api-client";

export type GateState = "loading" | "unauthenticated" | "no-organisation" | "error" | "ready";

/**
 * Pure decision for the dashboard auth gate.
 * - Any 401 (`UNAUTHENTICATED`) wins, even over cached data from before the session ended.
 * - Other errors only matter when there is no cached user to keep showing.
 */
export function resolveGateState(input: {
  isPending: boolean;
  error: unknown;
  /** Organisations from `GET /api/auth/me`; null while unknown. */
  organisationCount: number | null;
}): GateState {
  if (input.error) {
    if (isUnauthenticatedError(input.error)) return "unauthenticated";
    if (input.organisationCount === null) return "error";
  }
  if (input.isPending || input.organisationCount === null) return "loading";
  if (input.organisationCount === 0) return "no-organisation";
  return "ready";
}
