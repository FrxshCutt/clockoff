import type { Metadata } from "next";
import { NewPolicyView } from "@/components/policies/new-policy-view";

export const metadata: Metadata = { title: "New policy" };

export default function NewPolicyPage() {
  return <NewPolicyView />;
}
