import type { Metadata } from "next";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES } from "@/config/navigation";

export const metadata: Metadata = { title: "Import schedule" };

export default function ScheduleImportPage() {
  return (
    <PlaceholderPage
      title="Import schedule"
      description="Upload a CSV from your rota software. You'll map columns and review every row before anything is saved."
      emptyState="scheduleImport"
      eyebrow={<BackLink href={ROUTES.schedule}>Schedule</BackLink>}
    />
  );
}
