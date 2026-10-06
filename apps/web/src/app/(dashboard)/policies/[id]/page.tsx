import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES, isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Work Policy" };

export default async function PolicyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return (
    <PlaceholderPage
      title="Work Policy"
      emptyState="policyDetail"
      eyebrow={<BackLink href={ROUTES.policies}>Policies</BackLink>}
      inProgress
    />
  );
}
