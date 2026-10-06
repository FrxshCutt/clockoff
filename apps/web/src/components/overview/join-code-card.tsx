"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { routeFor } from "@/config/navigation";
import { useCurrentOrganisation } from "@/hooks/use-organisation";

/** Overview card with the company join code employees enter in the app. Hidden if the request fails. */
export function JoinCodeCard() {
  const { data, isPending, isError } = useCurrentOrganisation();
  if (isError) return null;

  return (
    <section aria-labelledby="join-code-card-title" className="bg-card flex flex-col gap-4 rounded-xl border p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex items-start gap-4">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
          <KeyRound className="size-5" />
        </span>
        <div className="space-y-1">
          <h2 id="join-code-card-title" className="font-semibold">
            Company join code
          </h2>
          <p className="text-muted-foreground text-sm">
            Employees enter this in the Work Mode app to join.{" "}
            <Link href={routeFor.settingsTab("join-code")} className="text-primary font-medium underline-offset-4 hover:underline">
              Manage
            </Link>
          </p>
        </div>
      </div>
      {isPending ? (
        <Skeleton className="h-10 w-40" />
      ) : data.joinCode ? (
        <div className="flex items-center gap-2">
          <span className="bg-muted/60 rounded-lg border px-3 py-1.5 font-mono text-xl font-semibold tracking-[0.2em]">
            {data.joinCode}
          </span>
          <CopyButton value={data.joinCode} label="Copy company join code" successMessage="Join code copied" />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No active code</p>
      )}
    </section>
  );
}
