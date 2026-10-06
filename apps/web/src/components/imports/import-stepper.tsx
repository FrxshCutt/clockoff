"use client";

import type { ShiftImportStatus } from "@workmode/shared/enums";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { IMPORT_STEPS, IMPORT_STEP_META, isStepReachable, stepState, type ImportStep } from "./import-wizard-model";

export interface ImportStepperProps {
  current: ImportStep;
  status: ShiftImportStatus | null;
  onSelect: (step: ImportStep) => void;
}

/** Numbered progress steps. Completed steps are buttons (you can go back); the rest are plain text. */
export function ImportStepper({ current, status, onSelect }: ImportStepperProps) {
  return (
    <nav aria-label="Import progress">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3 text-sm">
        {IMPORT_STEPS.map((step, index) => {
          const state = stepState(step, current);
          const reachable = state !== "current" && isStepReachable(step, status);
          const content = (
            <>
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                  state === "complete" && "border-primary bg-primary text-primary-foreground",
                  state === "current" && "border-primary text-primary",
                  state === "upcoming" && "border-border text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {state === "complete" ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className={cn("font-medium", state === "upcoming" && "text-muted-foreground")}>{IMPORT_STEP_META[step].label}</span>
            </>
          );
          return (
            <li key={step} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
              {reachable ? (
                <button
                  type="button"
                  onClick={() => onSelect(step)}
                  className="hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-1.5 py-1 outline-none focus-visible:ring-[3px]"
                >
                  {content}
                </button>
              ) : (
                <span className="flex items-center gap-2 px-1.5 py-1">{content}</span>
              )}
              {index < IMPORT_STEPS.length - 1 ? <span className="bg-border hidden h-px w-6 sm:block" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
