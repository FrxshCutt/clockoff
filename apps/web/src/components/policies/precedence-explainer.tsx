"use client";

import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { PRECEDENCE_LEVELS, PRECEDENCE_SUMMARY } from "./policy-view-model";

export interface PrecedenceExplainerProps {
  /** "policy" or "break rules" — fills the copy. */
  noun?: string;
  /** Overrides the "Which {noun} applies?" heading (e.g. for plural nouns). */
  title?: string;
  defaultOpen?: boolean;
  className?: string;
}

/** "Employee > Team > Location > Organisation" with a one-line explanation per level, collapsed by default. */
export function PrecedenceExplainer({
  noun = "policy",
  title,
  defaultOpen = false,
  className,
}: PrecedenceExplainerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = title ?? `Which ${noun} applies?`;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("bg-muted/40 rounded-lg border", className)}
    >
      <CollapsibleTrigger className="focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm outline-none focus-visible:ring-[3px]">
        <Layers className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{heading}</span>
          <span className="text-muted-foreground block text-xs">{PRECEDENCE_SUMMARY}</span>
        </span>
        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="space-y-2 border-t px-4 py-3">
          {PRECEDENCE_LEVELS.map((level) => (
            <li key={level.scopeType} className="flex gap-3 text-sm">
              <span
                className="bg-background text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums"
                aria-hidden="true"
              >
                {level.rank}
              </span>
              <span className="min-w-0">
                <span className="font-medium">{level.label}</span>
                <span className="text-muted-foreground"> — {level.description}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground border-t px-4 py-3 text-xs">
          The first level with an active assignment wins; nothing below it is looked at.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
