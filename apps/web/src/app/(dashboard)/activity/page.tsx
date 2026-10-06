import type { Metadata } from "next";
import { ActivityPage as ActivityView } from "@/components/activity/activity-page";

export const metadata: Metadata = { title: "Activity" };

/**
 * `/activity?tab=activity|compliance&employee=&type=&range=&from=&to=&location=&filter=&q=&page=`. The
 * client view reads and writes the search params itself, behind its own Suspense boundary.
 */
export default function Page() {
  return <ActivityView />;
}
