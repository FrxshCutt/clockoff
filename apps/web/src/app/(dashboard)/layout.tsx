import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/shell/dashboard-shell";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/** Cookie written by the shadcn sidebar when it is expanded/collapsed (components/ui/sidebar.tsx). */
const SIDEBAR_STATE_COOKIE = "sidebar_state";

/**
 * Manager dashboard frame. The auth gate is client-side (`DashboardShell` → `GET /api/auth/me`): signed-out
 * visitors go to `/login?next=…`, managers without an organisation to `/create-organisation`, and a full-page
 * skeleton renders until the session resolves so protected content never flashes. The sidebar's collapsed
 * state is read from its cookie here so the first paint matches the user's last choice.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get(SIDEBAR_STATE_COOKIE)?.value !== "false";
  return <DashboardShell defaultSidebarOpen={sidebarOpen}>{children}</DashboardShell>;
}
