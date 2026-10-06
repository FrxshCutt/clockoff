"use client";

import type { DateFormat } from "@workmode/shared/enums";
import { useCurrentOrganisation } from "@/hooks/use-organisation";

export interface OrgDateOptions {
  timeZone: string | undefined;
  dateFormat: DateFormat | undefined;
}

/** The organisation's time zone and date order for `formatDate*` calls (falls back to the viewer's while loading). */
export function useOrgDateOptions(): OrgDateOptions {
  const { data } = useCurrentOrganisation();
  return { timeZone: data?.organisation.timezone, dateFormat: data?.organisation.dateFormat };
}
