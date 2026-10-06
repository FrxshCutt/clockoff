import type { Metadata } from "next";
import { BreakRulesView } from "@/components/breakPolicies/break-policies-list";

export const metadata: Metadata = { title: "Break Rules" };

export default function BreakRulesPage() {
  return <BreakRulesView />;
}
