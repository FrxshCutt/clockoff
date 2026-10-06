"use client";

import { CopyButton } from "@/components/copy-button";
import { useCurrentOrganisation } from "@/hooks/use-organisation";

/** Compact "Join code ABC123 [copy]" chip in the top bar. Hidden until a code exists. */
export function JoinCodeQuickCopy() {
  const { data } = useCurrentOrganisation();
  const code = data?.joinCode;
  if (!code) return null;
  return (
    <div className="bg-muted/50 hidden h-9 items-center gap-2 rounded-md border pr-1 pl-3 text-sm lg:flex">
      <span className="text-muted-foreground">Join code</span>
      <span className="font-mono font-semibold tracking-wider">{code}</span>
      <CopyButton
        value={code}
        label="Copy company join code"
        successMessage="Join code copied"
        variant="ghost"
        size="icon-xs"
      />
    </div>
  );
}
