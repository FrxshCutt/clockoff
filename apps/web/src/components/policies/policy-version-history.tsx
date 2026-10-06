"use client";

import { History } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { describeVersionHistory } from "./policy-view-model";
import { useOrgDateOptions } from "./use-org-format";
import { usePolicyVersions } from "./use-policies";

export interface PolicyVersionHistoryProps {
  policyId: string;
  policyName: string;
}

/** Side panel listing every version: number, published when and by whom, change note and a config diff summary. */
export function PolicyVersionHistory({ policyId, policyName }: PolicyVersionHistoryProps) {
  const [open, setOpen] = useState(false);
  const versions = usePolicyVersions(policyId, { enabled: open });
  const { timeZone, dateFormat } = useOrgDateOptions();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline">
          <History aria-hidden="true" />
          Version history
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>{policyName}. Newest first; each entry lists what changed from the version before.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {versions.isPending ? (
              <div className="space-y-4" aria-busy="true">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="space-y-2 rounded-lg border p-4">
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ))}
              </div>
            ) : versions.isError ? (
              <ErrorState
                size="sm"
                title="Couldn't load versions"
                error={versions.error}
                onRetry={() => void versions.refetch()}
                isRetrying={versions.isRefetching}
              />
            ) : versions.data.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">No versions yet.</p>
            ) : (
              <ol className="space-y-3">
                {describeVersionHistory(versions.data).map(({ version, changes }) => (
                  <li key={version.id} className="space-y-2 rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold tabular-nums">v{version.versionNumber}</span>
                      {version.publishedAt ? (
                        <Badge variant="secondary">Published</Badge>
                      ) : (
                        <Badge variant="outline">Draft</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {version.publishedAt
                        ? `Published ${formatDateTime(version.publishedAt, { timeZone, dateFormat })}`
                        : `Created ${formatDateTime(version.createdAt, { timeZone, dateFormat })}`}
                      {version.createdBy ? ` by ${version.createdBy.name}` : ""}
                    </p>
                    {version.changeNote ? (
                      <blockquote className="border-l-2 pl-3 text-sm italic">{version.changeNote}</blockquote>
                    ) : null}
                    <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-sm">
                      {changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
