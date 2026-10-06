import type { Metadata } from "next";
import { EmployeesPage as EmployeesView } from "@/components/employees/employees-page";

export const metadata: Metadata = { title: "Employees" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /employees?filter=&q=&page=&pageSize=&locationId=&departmentId=&teamId=&policyId=&sort=. The raw query is
 * parsed by the client component, which then owns the state and keeps the URL in sync. The component is keyed
 * by the query so a client-side link to a different filtered view (e.g. from Overview) starts fresh.
 */
export default async function EmployeesPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const key = JSON.stringify(raw);
  return <EmployeesView key={key} initialSearch={raw} />;
}
