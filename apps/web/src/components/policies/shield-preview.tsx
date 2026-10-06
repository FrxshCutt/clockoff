import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ShieldPreviewProps {
  /** The manager's shield message; empty shows the app's own default copy. */
  message: string;
  organisationName?: string;
  className?: string;
}

/** Copy the iOS app shows when a policy has no shield message of its own. */
export const DEFAULT_SHIELD_PREVIEW_MESSAGE = "This app is paused while you're on shift.";

/**
 * Static mock-up of the iOS Screen Time shield an employee sees when they open a restricted app. Purely
 * visual (nothing here is interactive); it updates live as the manager types.
 */
export function ShieldPreview({ message, organisationName, className }: ShieldPreviewProps) {
  const text = message.trim() === "" ? DEFAULT_SHIELD_PREVIEW_MESSAGE : message.trim();
  return (
    <figure
      className={cn("mx-auto w-full max-w-xs", className)}
      aria-label="Preview of the iOS shield"
    >
      <div className="rounded-[2rem] border border-zinc-700/60 bg-zinc-950 p-3 shadow-xl">
        <div className="rounded-[1.5rem] bg-gradient-to-b from-zinc-800 to-zinc-900 px-5 pt-10 pb-8 text-center text-zinc-50">
          <div
            className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-white/10"
            aria-hidden="true"
          >
            <ShieldCheck className="size-8 text-emerald-300" />
          </div>
          <p className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Work Mode</p>
          <p className="mt-1 text-lg font-semibold">{organisationName ?? "Your organisation"}</p>
          <p className="mt-3 min-h-10 text-sm leading-5 text-pretty break-words text-zinc-200">
            {text}
          </p>
          <div
            className="mt-6 rounded-xl bg-white/10 py-2.5 text-sm font-semibold text-white"
            aria-hidden="true"
          >
            OK
          </div>
        </div>
      </div>
      <figcaption className="text-muted-foreground mt-2 text-center text-xs">
        {message.trim() === ""
          ? "Showing the app's default message."
          : "How the message appears on a restricted app."}
      </figcaption>
    </figure>
  );
}
