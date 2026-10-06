import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { CreatePolicyButton, PoliciesList } from "@/components/policies/policies-list";

export const metadata: Metadata = { title: "Policies" };

export default function PoliciesPage() {
  return (
    <>
      <PageHeader
        title="Policies"
        description="Work Policies decide which categories of apps are restricted during shifts."
        actions={<CreatePolicyButton />}
      />
      <PoliciesList />
    </>
  );
}
