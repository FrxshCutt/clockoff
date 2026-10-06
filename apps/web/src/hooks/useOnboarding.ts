"use client";

import { useOnboarding } from "@/hooks/use-organisation";

/**
 * Onboarding checklist progress (`GET /api/organisations/current/onboarding`). The computation is pure so
 * the overview card's copy ("3 of 8 steps complete · Next: …") is unit tested in node.
 */

export interface OnboardingStepLike {
  readonly key: string;
  readonly label: string;
  readonly done: boolean;
  readonly href: string;
}

export interface OnboardingProgress<T extends OnboardingStepLike = OnboardingStepLike> {
  readonly completedCount: number;
  readonly totalCount: number;
  /** 0–100, rounded. 0 when there are no steps. */
  readonly percent: number;
  /** Every step is done (false when there are no steps at all). */
  readonly allDone: boolean;
  /** The first step still to do, in checklist order. */
  readonly nextStep: T | null;
  readonly remaining: readonly T[];
}

export function computeOnboardingProgress<T extends OnboardingStepLike>(
  items: readonly T[],
): OnboardingProgress<T> {
  const totalCount = items.length;
  const remaining = items.filter((item) => !item.done);
  const completedCount = totalCount - remaining.length;
  return {
    completedCount,
    totalCount,
    percent: totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100),
    allDone: totalCount > 0 && remaining.length === 0,
    nextStep: remaining[0] ?? null,
    remaining,
  };
}

/** The onboarding query plus its derived progress (null until the checklist has loaded). */
export function useOnboardingProgress() {
  const query = useOnboarding();
  const progress = query.data ? computeOnboardingProgress(query.data.items) : null;
  return { query, progress };
}
