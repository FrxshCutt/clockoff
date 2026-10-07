"use client";

import { CAN_SEE, CANNOT_SEE, PRIVACY_PRINCIPLE } from "@clockoff/shared/privacyStatements";
import type { InviteInstructions } from "@clockoff/validation/invites";
import { Check, Copy, EyeOff, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { useInviteInstructions } from "@/components/employees/employee-api";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { routeFor } from "@/config/navigation";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDateTime } from "@/lib/format";

export interface InviteInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Instructions already in hand (e.g. from `POST /api/employees/:id/invites`). */
  instructions?: InviteInstructions | null;
  /** Otherwise fetched from `GET /api/invites/:id/instructions`. */
  inviteId?: string | null;
}

function CodeBlock({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="bg-muted/50 flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
        <p className="font-mono text-xl font-semibold tracking-[0.18em]">{value}</p>
      </div>
      <CopyButton value={value} label={copyLabel} successMessage={`${label} copied`} />
    </div>
  );
}

/**
 * Everything a manager needs to hand an employee: company code, personal invite code, install steps and the
 * privacy promise (what the employer can and cannot see), plus a one-click copy of the ready-to-send text.
 * Exported for other pages (schedule, overview) that surface invites.
 */
export function InviteInstructionsModal({
  open,
  onOpenChange,
  instructions: given,
  inviteId,
}: InviteInstructionsModalProps) {
  const query = useInviteInstructions(given ? null : (inviteId ?? null), {
    enabled: open && !given,
  });
  const organisation = useCurrentOrganisation({ enabled: open });
  const instructions = given ?? query.data ?? null;
  const { copy, copied } = useCopyToClipboard();

  const copyAll = async () => {
    if (!instructions) return;
    const ok = await copy(instructions.copyText);
    if (ok) toast.success("Instructions copied. Paste them into a message to the employee.");
    else toast.error("Couldn't copy. Select the text and copy it manually.");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Setup instructions
            {instructions
              ? ` for ${instructions.employee.firstName} ${instructions.employee.lastName}`
              : ""}
          </DialogTitle>
          <DialogDescription>
            Share these with the employee. They install the ClockOff app on their iPhone and enter
            both codes; Screen Time setup happens on their phone and stays private to them.
          </DialogDescription>
        </DialogHeader>

        {!instructions ? (
          query.isError ? (
            <ErrorState
              size="sm"
              title="Couldn't load the instructions"
              error={query.error}
              onRetry={() => void query.refetch()}
              isRetrying={query.isRefetching}
            />
          ) : (
            <div className="space-y-4" aria-busy="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )
        ) : (
          <div className="space-y-5">
            {instructions.companyCode === null ? (
              <InlineAlert
                variant="warning"
                title="No active company code"
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href={routeFor.settingsTab("join-code")}>Join code settings</Link>
                  </Button>
                }
              >
                The organisation&apos;s join code was revoked. Regenerate it before sharing these
                instructions, or the employee won&apos;t be able to find your organisation in the
                app.
              </InlineAlert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <CodeBlock
                label="Company code"
                value={instructions.companyCode ?? "—"}
                copyLabel="Copy company code"
              />
              <CodeBlock
                label="Employee code"
                value={instructions.inviteCode}
                copyLabel="Copy employee code"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              The employee code expires{" "}
              {formatDateTime(instructions.expiresAt, {
                timeZone: organisation.data?.organisation.timezone,
                dateFormat: organisation.data?.organisation.dateFormat,
              })}
              . Resend the invite to issue a new one.
            </p>

            <section aria-labelledby="invite-steps-title" className="space-y-2">
              <h3 id="invite-steps-title" className="text-sm font-semibold">
                Install steps
              </h3>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                {instructions.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              <a
                href={instructions.appStoreUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary inline-flex text-sm font-medium underline-offset-4 hover:underline"
              >
                Open the App Store listing
              </a>
            </section>

            <section
              aria-labelledby="invite-privacy-title"
              className="space-y-3 rounded-lg border p-4"
            >
              <div className="space-y-1">
                <h3 id="invite-privacy-title" className="text-sm font-semibold">
                  What your employer can and can&apos;t see
                </h3>
                <p className="text-muted-foreground text-xs">{PRIVACY_PRINCIPLE}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <PrivacyList
                  icon={ShieldCheck}
                  title="Can see"
                  items={
                    instructions.canSee.length > 0
                      ? instructions.canSee
                      : CAN_SEE.map((s) => s.label)
                  }
                  tone="ok"
                />
                <PrivacyList
                  icon={EyeOff}
                  title="Can't see"
                  items={
                    instructions.cannotSee.length > 0
                      ? instructions.cannotSee
                      : CANNOT_SEE.map((s) => s.label)
                  }
                  tone="no"
                />
              </div>
            </section>

            <section aria-labelledby="invite-copy-title" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 id="invite-copy-title" className="text-sm font-semibold">
                  Ready to send
                </h3>
                <Button type="button" size="sm" onClick={copyAll}>
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Copied" : "Copy instructions"}
                </Button>
              </div>
              <pre
                className="bg-muted/50 max-h-64 overflow-auto rounded-lg border p-4 font-sans text-sm whitespace-pre-wrap"
                tabIndex={0}
                aria-label="Ready-to-send instructions"
              >
                {instructions.copyText}
              </pre>
            </section>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PrivacyList({
  icon: Icon,
  title,
  items,
  tone,
}: {
  icon: typeof ShieldCheck;
  title: string;
  items: readonly string[];
  tone: "ok" | "no";
}) {
  const Mark = tone === "ok" ? Check : X;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="text-muted-foreground size-4" aria-hidden="true" />
        {title}
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="text-muted-foreground flex gap-2 text-sm">
            <Mark
              className={
                tone === "ok"
                  ? "mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  : "mt-0.5 size-4 shrink-0 text-zinc-400"
              }
              aria-hidden="true"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
