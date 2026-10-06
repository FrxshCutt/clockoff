import type { Metadata } from "next";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES } from "@/config/navigation";

export const metadata: Metadata = { title: "New Break Rules" };

export default function NewBreakRulesPage() {
  return (
    <PlaceholderPage
      title="New Break Rules"
      description="Let employees step away without switching Work Mode off."
      emptyState="breakRuleNew"
      eyebrow={<BackLink href={ROUTES.breakRules}>Break Rules</BackLink>}
      inProgress
    />
  );
}
