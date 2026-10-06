import type { Metadata } from "next";
import { BillingOverview } from "@/components/billing/billing-overview";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Billing" };

export default function BillingPage() {
  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan, what's included and how much of it you're using."
      />
      <BillingOverview />
    </>
  );
}
