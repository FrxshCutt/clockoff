import type { Metadata } from "next";
import { OverviewPage } from "@/components/overview/overview-page";

export const metadata: Metadata = { title: "Overview" };

/** `/overview` — the live compliance dashboard (see `components/overview`). */
export default function Page() {
  return <OverviewPage />;
}
