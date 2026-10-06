import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Locations & Teams" };

export default function LocationsPage() {
  return (
    <PlaceholderPage
      title="Locations & Teams"
      description="Group employees by site and team to assign policies and schedules in one go."
      emptyState="locations"
    />
  );
}
