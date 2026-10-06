import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreakPolicyDetailView } from "@/components/breakPolicies/break-policy-detail";
import { isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Break Rules" };

export default async function BreakRuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return <BreakPolicyDetailView id={id} />;
}
