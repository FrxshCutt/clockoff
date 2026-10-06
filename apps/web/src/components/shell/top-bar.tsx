"use client";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { CurrentUser } from "@/hooks/use-current-user";
import { Breadcrumbs } from "./breadcrumbs";
import { JoinCodeQuickCopy } from "./join-code-quick-copy";
import { NotificationsBell } from "./notifications-bell";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";

/** Sticky header: sidebar toggle, breadcrumbs, join code, notifications, org switcher and account menu. */
export function TopBar({ me }: { me: CurrentUser }) {
  return (
    <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur sm:px-4">
      <SidebarTrigger className="-ml-1" aria-label="Toggle navigation" />
      <Separator orientation="vertical" className="mr-1 hidden h-5 sm:block" />
      <Breadcrumbs className="flex-1" />
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <JoinCodeQuickCopy />
        <div className="hidden sm:block">
          <OrgSwitcher me={me} />
        </div>
        <NotificationsBell />
        <UserMenu me={me} />
      </div>
    </header>
  );
}
