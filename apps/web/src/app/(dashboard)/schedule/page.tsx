import type { Metadata } from "next";
import { SchedulePage as ScheduleView } from "@/components/schedule/schedule-page";

export const metadata: Metadata = { title: "Schedule" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /schedule?view=week|day|employee&date=YYYY-MM-DD&location=&employee=&cancelled=0. The raw query is
 * handed to the client component, which resolves defaults (today in the organisation's timezone) once the
 * session is known and keeps the URL in sync from then on.
 */
export default async function SchedulePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const initialSearch = {
    view: raw.view,
    date: raw.date,
    location: raw.location,
    employee: raw.employee,
    cancelled: raw.cancelled,
  };
  return <ScheduleView initialSearch={initialSearch} />;
}
