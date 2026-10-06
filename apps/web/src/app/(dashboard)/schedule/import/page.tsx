import type { Metadata } from "next";
import { ImportWizard } from "@/components/imports/import-wizard";
import { isResourceId } from "@/config/navigation";

export const metadata: Metadata = { title: "Import schedule" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** /schedule/import?import=<id> resumes an import that was started earlier; anything else starts fresh. */
export default async function ScheduleImportPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const candidate = Array.isArray(raw.import) ? raw.import[0] : raw.import;
  return <ImportWizard initialImportId={isResourceId(candidate) ? candidate : null} />;
}
