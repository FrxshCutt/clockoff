import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, PlaceholderPage } from "@/components/placeholder-page";
import { ROUTES, isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Device" };

export default async function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return (
    <PlaceholderPage
      title="Device"
      emptyState="deviceDetail"
      eyebrow={<BackLink href={ROUTES.devices}>Devices</BackLink>}
      inProgress
    />
  );
}
