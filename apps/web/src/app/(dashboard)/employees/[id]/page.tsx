import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES, isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Employee" };

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return (
    <PlaceholderPage
      title="Employee"
      emptyState="employeeDetail"
      eyebrow={<BackLink href={ROUTES.employees}>Employees</BackLink>}
      inProgress
    />
  );
}
