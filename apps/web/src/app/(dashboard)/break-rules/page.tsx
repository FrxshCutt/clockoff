import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Break Rules" };

export default function BreakRulesPage() {
  return (
    <PlaceholderPage
      title="Break Rules"
      description="How long breaks last, how often they can be taken and what relaxes during them."
      emptyState="breakRules"
    />
  );
}
