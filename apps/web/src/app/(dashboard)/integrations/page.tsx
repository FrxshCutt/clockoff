import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return (
    <PlaceholderPage
      title="Integrations"
      description="Connect your rota software to keep shifts in sync automatically."
      emptyState="integrations"
    />
  );
}
