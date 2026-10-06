import type { Metadata } from "next";
import { DevicesPage as DevicesView } from "@/components/devices/devices-page";

export const metadata: Metadata = { title: "Devices" };

/**
 * `/devices?active=&permission=&employee=&location=&page=&pageSize=` — filters live in the URL and are read
 * by the client view behind its own Suspense boundary.
 */
export default function Page() {
  return <DevicesView />;
}
