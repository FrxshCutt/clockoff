import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Employees" };

export default function EmployeesPage() {
  return (
    <PlaceholderPage
      title="Employees"
      description="Everyone who works shifts, their invite status and whether their phone is connected."
      emptyState="employees"
    />
  );
}
