import type { Metadata } from "next";
import { IntegrationsList } from "@/components/integrations/integrations-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect your rota software to keep shifts in sync automatically. Providers are coming soon; CSV import works today."
      />
      <IntegrationsList />
    </>
  );
}
