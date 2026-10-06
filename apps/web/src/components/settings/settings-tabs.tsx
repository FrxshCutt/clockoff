"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_META,
  parseSettingsTab,
  type SettingsTab,
} from "@/config/settings";
import { DangerZone } from "./danger-zone";
import { JoinCodeSettings } from "./join-code-settings";
import { MembersSettings } from "./members-settings";
import { NotificationSettings } from "./notification-settings";
import { OrganisationSettings } from "./organisation-settings";

function TabBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "organisation":
      return <OrganisationSettings />;
    case "join-code":
      return <JoinCodeSettings />;
    case "members":
      return <MembersSettings />;
    case "notifications":
      return <NotificationSettings />;
    case "danger-zone":
      return <DangerZone />;
  }
}

/**
 * Settings tabs. The selected tab is mirrored to `?tab=` with `history.replaceState` (no server round trip)
 * so links like `/settings?tab=members` and reloads land on the same tab. Arrow keys move between tabs.
 */
export function SettingsTabs({ initialTab }: { initialTab: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  const onValueChange = (value: string) => {
    const next = parseSettingsTab(value);
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  };

  return (
    <Tabs value={tab} onValueChange={onValueChange} className="gap-6">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList aria-label="Settings sections" className="w-max">
          {SETTINGS_TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="px-3">
              {SETTINGS_TAB_META[id].label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {SETTINGS_TABS.map((id) => (
        <TabsContent key={id} value={id} className="space-y-6 outline-none">
          <p className="text-muted-foreground text-sm">{SETTINGS_TAB_META[id].description}</p>
          {/* Radix only mounts the active panel, so inactive tabs don't fetch. */}
          <TabBody tab={id} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
