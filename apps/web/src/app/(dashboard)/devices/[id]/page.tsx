import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeviceDetail } from "@/components/devices/device-detail";
import { isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Device" };

/** `/devices/[id]` — 404 for anything that is not a UUID before the API is asked. */
export default async function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isResourceId(id)) notFound();
  return <DeviceDetail id={id} />;
}
