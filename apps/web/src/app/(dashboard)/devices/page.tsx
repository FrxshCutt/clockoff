import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Devices" };

export default function DevicesPage() {
  return (
    <PlaceholderPage
      title="Devices"
      description="Phones connected to Work Mode, with Screen Time permission and sync status."
      emptyState="devices"
    />
  );
}
