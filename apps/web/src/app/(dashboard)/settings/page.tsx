import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { parseSettingsTab } from "@/config/settings";

export const metadata: Metadata = { title: "Settings" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).tab;
  const tab = parseSettingsTab(Array.isArray(raw) ? raw[0] : raw);
  return (
    <>
      <PageHeader title="Settings" description="Your organisation, join code, managers and notification preferences." />
      <SettingsTabs initialTab={tab} />
    </>
  );
}
