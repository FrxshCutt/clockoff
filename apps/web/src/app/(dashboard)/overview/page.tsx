import type { Metadata } from "next";
import { JoinCodeCard } from "@/components/overview/join-code-card";
import { OnboardingChecklist } from "@/components/overview/onboarding-checklist";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <PlaceholderPage
      title="Overview"
      description="Who's in Work Mode right now, who's on a break and what needs your attention."
      emptyState="overview"
    >
      <div className="mb-6 space-y-6">
        <OnboardingChecklist />
        <JoinCodeCard />
      </div>
    </PlaceholderPage>
  );
}
