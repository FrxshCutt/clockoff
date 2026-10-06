import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmployeeDetailPage as EmployeeDetailView } from "@/components/employees/employee-detail-page";
import { isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Employee" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** /employees/[id]?tab=overview|schedule|policy|activity|invites|overrides. Non-UUID ids 404 without calling the API. */
export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  if (!isResourceId(id)) notFound();
  const tab = Array.isArray(raw.tab) ? raw.tab[0] : raw.tab;
  return <EmployeeDetailView key={`${id}:${tab ?? ""}`} id={id} initialTab={tab} />;
}
