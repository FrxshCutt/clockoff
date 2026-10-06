import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Schedule" };

export default function SchedulePage() {
  return (
    <PlaceholderPage
      title="Schedule"
      description="Shifts switch Work Mode on and off automatically on each employee's phone."
      emptyState="schedule"
    />
  );
}
