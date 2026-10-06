import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Policies" };

export default function PoliciesPage() {
  return (
    <PlaceholderPage
      title="Policies"
      description="Work Policies decide which categories of apps are restricted during shifts."
      emptyState="policies"
    />
  );
}
