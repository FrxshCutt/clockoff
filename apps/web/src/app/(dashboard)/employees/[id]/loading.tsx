import { EmployeeDetailSkeleton } from "@/components/employees/employee-detail-skeleton";

/** Route-level loading frame for /employees/[id]: keeps the page's single `<h1>` slot while the segment loads. */
export default function EmployeeDetailLoading() {
  return <EmployeeDetailSkeleton />;
}
