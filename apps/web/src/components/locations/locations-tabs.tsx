"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DepartmentsSection } from "./departments-list";
import { LocationsSection } from "./locations-table";
import { LOCATIONS_TABS, LOCATIONS_TAB_META, parseLocationsTab, type LocationsTab } from "./locations-view-model";
import { TeamsSection } from "./teams-table";

function TabBody({ tab }: { tab: LocationsTab }) {
  switch (tab) {
    case "locations":
      return <LocationsSection />;
    case "departments":
      return <DepartmentsSection />;
    case "teams":
      return <TeamsSection />;
  }
}

/**
 * Locations / Departments / Teams tabs. The selected tab is mirrored to `?tab=` with `history.replaceState`
 * (no server round trip) so links like `/locations?tab=teams` and reloads land on the same tab.
 */
export function LocationsTabs({ initialTab }: { initialTab: LocationsTab }) {
  const [tab, setTab] = useState<LocationsTab>(initialTab);

  const onValueChange = (value: string) => {
    const next = parseLocationsTab(value);
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  return (
    <Tabs value={tab} onValueChange={onValueChange} className="gap-6">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList aria-label="Locations and teams sections" className="w-max">
          {LOCATIONS_TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="px-3">
              {LOCATIONS_TAB_META[id].label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {LOCATIONS_TABS.map((id) => (
        <TabsContent key={id} value={id} className="space-y-6 outline-none">
          <p className="text-muted-foreground text-sm">{LOCATIONS_TAB_META[id].description}</p>
          {/* Radix only mounts the active panel, so inactive tabs don't fetch. */}
          <TabBody tab={id} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
