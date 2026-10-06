import type { Metadata } from "next";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES } from "@/config/navigation";

export const metadata: Metadata = { title: "New policy" };

export default function NewPolicyPage() {
  return (
    <PlaceholderPage
      title="New Work Policy"
      description="Decide which distractions are restricted while employees are on shift."
      emptyState="policyNew"
      eyebrow={<BackLink href={ROUTES.policies}>Policies</BackLink>}
      inProgress
    />
  );
}
