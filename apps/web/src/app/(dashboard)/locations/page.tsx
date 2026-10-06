import type { Metadata } from "next";
import { LocationsTabs } from "@/components/locations/locations-tabs";
import { parseLocationsTab } from "@/components/locations/locations-view-model";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Locations & Teams" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LocationsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).tab;
  const tab = parseLocationsTab(Array.isArray(raw) ? raw[0] : raw);
  return (
    <>
      <PageHeader
        title="Locations & Teams"
        description="Group employees by site and team so you can assign Work Policies and Break Rules to the right people at once."
      />
      <LocationsTabs initialTab={tab} />
    </>
  );
}
