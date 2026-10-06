import type { Metadata } from "next";
import { NewBreakPolicyView } from "@/components/breakPolicies/new-break-policy-view";

export const metadata: Metadata = { title: "New Break Rules" };

export default function NewBreakRulesPage() {
  return <NewBreakPolicyView />;
}
