import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PolicyDetailView } from "@/components/policies/policy-detail";
import { isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Work Policy" };

export default async function PolicyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return <PolicyDetailView id={id} />;
}
