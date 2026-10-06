import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <PlaceholderPage
      title="Activity"
      description="A timeline of joins, setup, Work Mode and breaks across your organisation."
      emptyState="activity"
    />
  );
}
