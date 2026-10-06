"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

/**
 * Page state kept in the URL (filters, tab, page): `parse` reads it from the search params, `serialize`
 * writes it back. Updates use `router.replace` without scrolling so filters don't pile up history entries,
 * and the URL stays shareable. Both functions must be stable (module-level).
 */
export function useUrlState<T>(
  parse: (params: URLSearchParams) => T,
  serialize: (state: T) => string,
): readonly [T, (next: T | ((previous: T) => T)) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = useMemo(
    () => parse(new URLSearchParams(searchParams.toString())),
    [parse, searchParams],
  );

  const setState = useCallback(
    (next: T | ((previous: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(state) : next;
      const qs = serialize(resolved);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, serialize, state],
  );

  return [state, setState] as const;
}
