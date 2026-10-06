"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Lets a page replace a dynamic breadcrumb segment (an id) with a human label, e.g. an employee's name:
 * `useBreadcrumbLabel(employeeId, employee?.name)`. Labels are removed when the page unmounts.
 */
let labels: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: Readonly<Record<string, string>> = {};

export function useBreadcrumbLabels(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    subscribe,
    () => labels,
    () => EMPTY,
  );
}

export function useBreadcrumbLabel(
  segment: string | null | undefined,
  label: string | null | undefined,
): void {
  useEffect(() => {
    if (!segment || !label) return;
    labels = { ...labels, [segment]: label };
    emit();
    return () => {
      const { [segment]: _removed, ...rest } = labels;
      labels = rest;
      emit();
    };
  }, [segment, label]);
}
