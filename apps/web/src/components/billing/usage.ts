import { UNLIMITED, type LimitValue } from "@clockoff/shared/plans";

/** Percentage of a plan limit used, rounded and capped at 100; null for unlimited or zero limits. */
export function usagePercent(used: number, limit: LimitValue): number | null {
  if (limit === UNLIMITED || limit <= 0) return null;
  if (!Number.isFinite(used) || used <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}
